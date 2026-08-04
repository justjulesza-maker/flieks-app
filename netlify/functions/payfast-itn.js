/**
 * payfast-itn — 4flieks payment webhook.
 *
 * Grants access, mints gift codes, and records which cast member drove the sale.
 *
 * Changes from the previous version:
 *   1. Signature is built in the order PayFast posted the fields, not sorted.
 *      Sorting produces a different hash, so every ITN failed verification.
 *   2. Updates the pending transaction the browser created (keyed by
 *      m_payment_id) instead of writing a second, unrelated record.
 *   3. Ignores a repeated ITN rather than granting and counting twice.
 *   4. Gift purchases mint a code instead of granting access.
 *   5. Records attribution to flieks_stats.
 */
const crypto = require('crypto');
const https  = require('https');

const PF_PASSPHRASE = process.env.PAYFAST_PASSPHRASE || '';
const IS_SANDBOX    = process.env.PAYFAST_SANDBOX === 'true';
const FB_DB_URL     = (process.env.FIREBASE_DB_URL || '').replace(/\/$/, '');
const FB_SECRET     = process.env.FIREBASE_DB_SECRET;

/* ── firebase helpers ─────────────────────────────────────────────────────── */

function fbRequest(path, method, value) {
  const body = value === undefined ? null : JSON.stringify(value);
  const url  = new URL(`${FB_DB_URL}/${path}.json?auth=${FB_SECRET}`);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: body
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        : {}
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(d ? JSON.parse(d) : null); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const fbGet   = p        => fbRequest(p, 'GET');
const fbPut   = (p, v)   => fbRequest(p, 'PUT', v);
const fbPatch = (p, v)   => fbRequest(p, 'PATCH', v);

async function fbIncrement(path, field) {
  const current = await fbGet(`${path}/${field}`);
  await fbPut(`${path}/${field}`, (parseInt(current) || 0) + 1);
}

/* ── payfast helpers ──────────────────────────────────────────────────────── */

/**
 * PayFast signs the ITN payload in the order the fields arrive. Rebuilding it
 * from a sorted object gives a different string and therefore a different
 * hash, so the raw body is parsed in sequence here rather than via an object.
 */
function signatureFromRawBody(rawBody) {
  const pairs = rawBody.split('&').filter(p => !p.startsWith('signature='));
  const qs = pairs.join('&');
  const full = PF_PASSPHRASE
    ? `${qs}&passphrase=${encodeURIComponent(PF_PASSPHRASE.trim()).replace(/%20/g, '+')}`
    : qs;
  return crypto.createHash('md5').update(full).digest('hex');
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* Gift codes: 6 characters, no 0 O 1 I L, so they survive being read aloud. */
const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function giftCode(seed) {
  const h = crypto.createHash('sha256').update(seed + FB_SECRET).digest();
  let out = '';
  for (let i = 0; i < 6; i++) out += ALPHA[h[i] % ALPHA.length];
  return 'FL-' + out;
}

/* ── handler ──────────────────────────────────────────────────────────────── */

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const rawBody = event.body || '';
    const data = Object.fromEntries(new URLSearchParams(rawBody));

    console.log('ITN received:', JSON.stringify({
      status: data.payment_status,
      pf_id:  data.pf_payment_id,
      m_id:   data.m_payment_id,
      gross:  data.amount_gross,
      film:   data.custom_str1,
      type:   data.custom_str2,
      ref:    data.custom_str4
    }));

    /* 1 — signature, using the order PayFast sent */
    const expected = signatureFromRawBody(rawBody);
    if (data.signature !== expected) {
      console.error('Signature mismatch', { received: data.signature, expected });
      return { statusCode: 400, body: 'Invalid signature' };
    }

    /* 2 — confirm with PayFast that they really sent it */
    const pfHost = IS_SANDBOX ? 'sandbox.payfast.co.za' : 'www.payfast.co.za';
    const verify = await httpsPost(`https://${pfHost}/eng/query/validate`, rawBody);
    if (!/VALID/i.test(verify)) {
      console.error('PayFast validation failed:', verify);
      return { statusCode: 400, body: 'Payment validation failed' };
    }

    /* 3 — only act on completed payments */
    if (data.payment_status !== 'COMPLETE') {
      console.log('Ignoring status:', data.payment_status);
      return { statusCode: 200, body: 'Not complete' };
    }

    /* 4 — prefer the pending transaction the browser wrote; fall back to the
           custom fields, which PayFast occasionally trims */
    const txId = data.m_payment_id;
    const tx   = (txId && await fbGet(`flieks_transactions/${txId}`)) || {};

    const filmId = tx.film_id || data.custom_str1;
    const type   = tx.type    || data.custom_str2;     // rent | own | gift
    const uid    = tx.uid     || data.custom_str3;
    const ref    = tx.ref     || data.custom_str4 || null;
    const gross  = parseFloat(data.amount_gross) || 0;

    if (!filmId || !type || !uid) {
      console.error('Missing fields', { filmId, type, uid });
      return { statusCode: 400, body: 'Missing custom fields' };
    }

    /* 5 — a repeat delivery must not grant or count twice */
    if (tx.status === 'complete') {
      console.log('Already processed:', txId);
      return { statusCode: 200, body: 'Already processed' };
    }

    const now = Date.now();

    if (type === 'gift') {
      /* The buyer gets a code, not access. */
      const code = giftCode(txId || data.pf_payment_id);
      await fbPut(`flieks_gifts/${code}`, {
        filmId,
        buyerUid:   uid,
        buyerEmail: data.email_address || '',
        toName:     tx.gift_to  || '',
        message:    tx.gift_msg || '',
        amount:     gross,
        ref,
        claimedBy:  null,
        claimedAt:  null,
        createdAt:  now
      });
      // private pointer so the buyer can see their own code and nobody else's
      await fbPatch(`flieks_my_gifts/${uid}`, { [code]: now });
      console.log(`Gift minted: ${code} for ${filmId}`);

    } else {
      const expiresAt = type === 'rent' ? now + 48 * 60 * 60 * 1000 : null;
      await fbPut(`flieks_purchases/${uid}/${filmId}`, {
        film_id: filmId,
        uid,
        type,
        purchased_at: now,
        created_at:   now,
        expires_at:   expiresAt,
        transaction_id: data.pf_payment_id,
        amount: gross,
        ref,
        status: 'complete'
      });
      await fbIncrement(`flieks_films/${filmId}`, type === 'own' ? 'own_count' : 'rent_count');
      console.log(`Access granted: ${uid} -> ${filmId} (${type})`);
    }

    /* 6 — close off the transaction the browser opened */
    if (txId) {
      await fbPatch(`flieks_transactions/${txId}`, {
        status: 'complete',
        pf_payment_id: data.pf_payment_id,
        amount_paid: gross,
        completed_at: now
      });
    } else {
      await fbPut(`flieks_transactions/${data.pf_payment_id}`, {
        uid, film_id: filmId, type, amount: gross, ref,
        pf_payment_id: data.pf_payment_id,
        created_at: now, completed_at: now, status: 'complete'
      });
    }

    /* 7 — attribution: which cast member's link earned this */
    if (ref) {
      const s = (await fbGet(`flieks_stats/${filmId}/refs/${ref}`)) || {};
      await fbPatch(`flieks_stats/${filmId}/refs/${ref}`, {
        sales:   (s.sales   || 0) + 1,
        revenue: +(((s.revenue || 0) + gross).toFixed(2)),
        [`by_${type}`]: (s[`by_${type}`] || 0) + 1
      });
      console.log(`Attributed to ${ref}`);
    }

    const t = (await fbGet(`flieks_stats/${filmId}/totals`)) || {};
    await fbPatch(`flieks_stats/${filmId}/totals`, {
      sales:   (t.sales   || 0) + 1,
      revenue: +(((t.revenue || 0) + gross).toFixed(2)),
      [`by_${type}`]: (t[`by_${type}`] || 0) + 1
    });

    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('ITN handler error:', err);
    return { statusCode: 500, body: 'Internal error' };
  }
};
