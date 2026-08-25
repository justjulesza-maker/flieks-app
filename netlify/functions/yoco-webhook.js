/**
 * yoco-webhook — Yoco payment notifications.
 *
 * Grants access, mints gift codes, and records which cast member drove the sale.
 * Replaces payfast-itn.js.
 *
 * Yoco signs webhooks using the Standard Webhooks scheme: HMAC-SHA256 over
 * "{webhook-id}.{webhook-timestamp}.{raw body}" with the base64 secret that was
 * issued when the webhook was registered.
 *
 * Netlify environment variables:
 *   YOCO_WEBHOOK_SECRET   whsec_... from registering the webhook
 *   FIREBASE_DB_URL
 *   FIREBASE_DB_SECRET
 */
const crypto = require('crypto');
const https  = require('https');

const DB     = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET = process.env.FIREBASE_DB_SECRET;
const WHSEC  = (process.env.YOCO_WEBHOOK_SECRET || '').trim();

/* ── firebase ─────────────────────────────────────────────────────────────── */

function fbRequest(path, method, value) {
  const body = value === undefined ? null : JSON.stringify(value);
  const url  = new URL(`${DB}/${path}.json?auth=${SECRET}`);
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
      res.on('end', () => { try { resolve(d ? JSON.parse(d) : null); } catch { resolve(null); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const fbGet   = p      => fbRequest(p, 'GET');
const fbPut   = (p, v) => fbRequest(p, 'PUT', v);
const fbPatch = (p, v) => fbRequest(p, 'PATCH', v);

async function fbIncrement(path, field) {
  const current = await fbGet(`${path}/${field}`);
  await fbPut(`${path}/${field}`, (parseInt(current) || 0) + 1);
}

/* ── signature ────────────────────────────────────────────────────────────── */

function verifySignature(headers, rawBody) {
  if (!WHSEC) {
    console.warn('YOCO_WEBHOOK_SECRET not set — cannot verify signature');
    return false;
  }
  const h = k => headers[k] || headers[k.toLowerCase()];
  const id = h('webhook-id');
  const ts = h('webhook-timestamp');
  const sigHeader = h('webhook-signature');
  if (!id || !ts || !sigHeader) return false;

  // Reject anything older than five minutes — blocks replayed notifications.
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) {
    console.error('webhook timestamp out of range', { ts, age });
    return false;
  }

  const secretBytes = Buffer.from(WHSEC.replace(/^whsec_/, ''), 'base64');
  const signed = `${id}.${ts}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signed).digest('base64');

  // The header may carry several space-separated versioned signatures.
  return sigHeader.split(' ').some(part => {
    const value = part.includes(',') ? part.split(',')[1] : part;
    if (!value || value.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
  });
}

/* ── gift codes ───────────────────────────────────────────────────────────── */

/* 6 characters, no 0 O 1 I L, so they survive being read aloud. */
const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function giftCode(seed) {
  const h = crypto.createHash('sha256').update(seed + SECRET).digest();
  let out = '';
  for (let i = 0; i < 6; i++) out += ALPHA[h[i] % ALPHA.length];
  return 'FL-' + out;
}

/* ── handler ──────────────────────────────────────────────────────────────── */

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  const rawBody = event.body || '';

  try {
    if (!verifySignature(event.headers || {}, rawBody)) {
      console.error('webhook signature rejected');
      return { statusCode: 401, body: 'Invalid signature' };
    }

    const evt = JSON.parse(rawBody || '{}');
    const payload = evt.payload || {};
    const meta = payload.metadata || {};

    console.log('webhook:', {
      type: evt.type,
      paymentId: payload.id,
      amount: payload.amount,
      mode: payload.mode || payload.processingMode,
      txId: meta.txId
    });

    /* Only completed payments do anything. */
    if (evt.type !== 'payment.succeeded') {
      return { statusCode: 200, body: 'Ignored' };
    }

    const txId = meta.txId;
    const tx = (txId && await fbGet(`flieks_transactions/${txId}`)) || {};

    const filmId = tx.film_id || meta.filmId;
    const type   = tx.type    || meta.type;      // rent | own | gift
    const uid    = tx.uid     || meta.uid;
    const ref    = tx.ref     || meta.ref || null;
    const gross  = (Number(payload.amount) || 0) / 100;   // cents back to rand
    // Stamped on every record so test and live are distinguishable at a glance,
    // rather than having to work it out from timestamps later.
    const mode   = payload.mode || payload.processingMode || 'live';

    if (!filmId || !type || !uid) {
      console.error('missing details', { filmId, type, uid, txId, meta });
      return { statusCode: 400, body: 'Missing details' };
    }

    /* A repeated delivery must not grant or count twice. */
    if (tx.status === 'complete') {
      console.log('already processed:', txId);
      return { statusCode: 200, body: 'Already processed' };
    }

    const now = Date.now();

    if (type === 'gift') {
      /* The buyer gets a code, not access. */
      const code = giftCode(txId || String(payload.id));
      const buyer = await fbGet(`flieks_users/${uid}`) || {};
      const film  = await fbGet(`flieks_films/${filmId}`) || {};

      await fbPut(`flieks_gifts/${code}`, {
        filmId,
        buyerUid:   uid,
        buyerEmail: tx.email || '',
        buyerName:  buyer.name || buyer.display_name || '',
        toName:     tx.gift_to  || '',
        message:    tx.gift_msg || '',
        amount:     gross,
        ref,
        txId,
        mode,
        claimedBy:  null,
        claimedAt:  null,
        createdAt:  now
      });

      // Private pointer so the buyer can find their own code again.
      await fbPatch(`flieks_my_gifts/${uid}`, {
        [code]: {
          at: now,
          filmId,
          filmTitle: film.title || tx.film_title || '',
          filmSlug:  film.slug || filmId,
          toName:    tx.gift_to  || '',
          message:   tx.gift_msg || ''
        }
      });
      console.log(`Gift minted: ${code} for ${filmId}`);

    } else {
      /* Rentals start their 48 hours on first play, not here. */
      await fbPut(`flieks_purchases/${uid}/${filmId}`, {
        film_id: filmId,
        uid,
        type,
        purchased_at: now,
        created_at:   now,
        expires_at:   null,
        rental_hours: type === 'rent' ? 48 : null,
        transaction_id: payload.id || txId,
        amount: gross,
        ref,
        mode,
        status: 'complete'
      });
      await fbIncrement(`flieks_films/${filmId}`, type === 'own' ? 'own_count' : 'rent_count');
      console.log(`Access granted: ${uid} -> ${filmId} (${type})`);
    }

    /* Close off the transaction the checkout opened. */
    if (txId) {
      await fbPatch(`flieks_transactions/${txId}`, {
        status: 'complete',
        payment_id: payload.id || '',
        amount_paid: gross,
        mode,
        completed_at: now
      });
    }

    /* Attribution: which cast member's link earned this.
       Test payments still grant access so the flow can be checked end to end,
       but they must not appear in anyone's sales figures. */
    if (mode === 'test') {
      console.log('test mode — access granted, stats not counted');
      return { statusCode: 200, body: 'OK (test)' };
    }

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
    console.error('webhook error:', err);
    // 500 tells Yoco to retry, which is what we want if our side failed.
    return { statusCode: 500, body: 'Internal error' };
  }
};
