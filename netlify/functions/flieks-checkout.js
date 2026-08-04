/**
 * flieks-checkout — builds a signed PayFast payload.
 *
 * The browser sends only { filmId, type }. The price is read from the
 * database here, so it cannot be tampered with, and the payload is signed,
 * so PayFast will reject anything altered in transit.
 *
 * POST { token, filmId, type, giftTo?, giftMsg?, ref? }
 *   -> { action, fields, txId }
 *
 * Needs these Netlify environment variables:
 *   PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY, PAYFAST_PASSPHRASE,
 *   PAYFAST_SANDBOX, FIREBASE_DB_URL, FIREBASE_DB_SECRET, FIREBASE_API_KEY
 */
const crypto = require('crypto');
const https  = require('https');

const DB      = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET  = process.env.FIREBASE_DB_SECRET;
const API_KEY = process.env.FIREBASE_API_KEY;
/* Accept true/1/yes in any case. A stray capital or space here silently
   posts sandbox credentials to the live endpoint, which is a baffling failure. */
const SANDBOX = ['true', '1', 'yes', 'on']
  .includes(String(process.env.PAYFAST_SANDBOX || '').trim().toLowerCase());
const PF_HOST = SANDBOX ? 'https://sandbox.payfast.co.za/eng/process'
                        : 'https://www.payfast.co.za/eng/process';

const VAT_RATE = 0.15;

/* ── plumbing ─────────────────────────────────────────────────────────────── */

function req(url, opts = {}, body = null) {
  return new Promise((res, rej) => {
    const r = https.request(url, opts, x => {
      let d = ''; x.on('data', c => d += c);
      x.on('end', () => res({ status: x.statusCode, body: d }));
    });
    r.on('error', rej);
    if (body) r.write(body);
    r.end();
  });
}

const dbGet = async path => {
  const r = await req(`${DB}/${path}.json?auth=${SECRET}`);
  return JSON.parse(r.body || 'null');
};

const dbPut = async (path, data) => {
  const b = JSON.stringify(data);
  return req(`${DB}/${path}.json?auth=${SECRET}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);
};

async function verifyToken(token) {
  if (!API_KEY) {
    throw new Error('FIREBASE_API_KEY is not set on this Netlify site. ' +
      'Add it under Site configuration -> Environment variables, then redeploy.');
  }
  const b = JSON.stringify({ idToken: token });
  const r = await req(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);

  let d = {};
  try { d = JSON.parse(r.body || '{}'); } catch {}

  if (!d.users || !d.users[0]) {
    // Google's own message is far more useful than a generic failure
    const reason = (d.error && (d.error.message || d.error.status)) || r.body || 'no user returned';
    console.error('token verification failed:', {
      httpStatus: r.status,
      googleSays: reason,
      apiKeyLooksValid: /^AIza[\w-]{30,}$/.test(API_KEY),
      apiKeyLength: API_KEY.length,
      tokenLength: (token || '').length
    });
    throw new Error('bad token: ' + reason);
  }
  return d.users[0];
}

/* ── signing ──────────────────────────────────────────────────────────────── */

/* PayFast's backend uses PHP urlencode(). encodeURIComponent leaves
   ! ' ( ) * ~ alone; PHP escapes them. Spaces become '+' in both. */
function pfEncode(v) {
  return encodeURIComponent(String(v))
    .replace(/%20/g, '+')
    .replace(/[!'()*~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function sign(fields, passphrase) {
  const qs = Object.entries(fields)
    .map(([k, v]) => `${k}=${pfEncode(v)}`)
    .join('&');
  const full = passphrase ? `${qs}&passphrase=${pfEncode(passphrase.trim())}` : qs;
  return crypto.createHash('md5').update(full).digest('hex');
}

const fail = (code, message) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message })
});

/* ── handler ──────────────────────────────────────────────────────────────── */

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  try {
    const { token, filmId, type, giftTo, giftMsg, ref, returnUrl } =
      JSON.parse(event.body || '{}');

    console.log('checkout:', { type, filmId, sandbox: SANDBOX, posting_to: PF_HOST,
      merchant: process.env.PAYFAST_MERCHANT_ID });

    if (!token || !filmId || !['rent', 'own', 'gift'].includes(type)) {
      return fail(400, 'Missing or invalid request.');
    }

    // "Who's it for" is a name. An email there looks like buyer data to
    // PayFast and trips its same-account check with a baffling error.
    if (type === 'gift' && giftTo && /\S+@\S+\.\S+/.test(giftTo)) {
      return fail(400, "Use their name, not an email — you'll get a code to send them.");
    }

    const user = await verifyToken(token);
    const film = await dbGet(`flieks_films/${filmId}`);

    if (!film) return fail(404, 'That film could not be found.');
    if (film.status !== 'live') return fail(403, 'That film is not on sale.');

    /* The price comes from the database, never from the browser. */
    const base = type === 'rent' ? Number(film.price_rent) : Number(film.price_own);
    if (!(base > 0)) return fail(400, 'That film has no price set.');

    const vat   = +(base * VAT_RATE).toFixed(2);
    const total = +(base + vat).toFixed(2);

    /* Already owns it? Don't take their money twice. */
    if (type !== 'gift') {
      const existing = await dbGet(`flieks_purchases/${user.localId}/${filmId}`);
      if (existing && existing.type === 'own') {
        return fail(409, 'You already own this film.');
      }
      if (existing && existing.type === 'rent' && existing.expires_at > Date.now()) {
        return fail(409, 'Your rental of this film is still active.');
      }
    }

    const txId = `fl-${type}-${user.localId.slice(0, 6)}-${Date.now().toString(36)}`;
    const origin = (returnUrl || 'https://4flieks.com').split('?')[0].replace(/\/$/, '');

    /* Park the intent so the ITN knows what was bought even if PayFast
       trims the custom fields. */
    await dbPut(`flieks_transactions/${txId}`, {
      uid: user.localId,
      email: user.email || '',
      film_id: filmId,
      film_title: film.title || '',
      type,
      amount: base,
      vat,
      total,
      platform_fee:    +(base * 0.30).toFixed(2),
      filmmaker_share: +(base * 0.70).toFixed(2),
      filmmaker_uid: film.filmmaker_uid || null,
      ref: ref || null,
      gift_to:  type === 'gift' ? (giftTo  || '').slice(0, 80)  : null,
      gift_msg: type === 'gift' ? (giftMsg || '').slice(0, 300) : null,
      status: 'pending',
      created_at: Date.now()
    });

    const label = type === 'own' ? 'Own' : type === 'gift' ? 'Gift' : 'Rent';
    const clean = s => String(s || '').replace(/[^\x20-\x7E]/g, '').trim();

    const fields = {
      merchant_id:   process.env.PAYFAST_MERCHANT_ID,
      merchant_key:  process.env.PAYFAST_MERCHANT_KEY,
      return_url:    `${origin}/?payment=success`,
      cancel_url:    `${origin}/?payment=cancel`,
      notify_url:    `${origin}/.netlify/functions/payfast-itn`,
      name_first:    clean((user.displayName || 'Viewer').split(' ')[0]) || 'Viewer',
      email_address: user.email || '',
      m_payment_id:  txId,
      amount:        total.toFixed(2),
      item_name:     clean(`FLIEKS: ${film.title || filmId} (${label})`).slice(0, 100),
      custom_str1:   filmId,
      custom_str2:   type,
      custom_str3:   user.localId,
      custom_str4:   ref || ''
    };

    /* Normalise before signing so the bytes signed are the bytes posted.
       A stray space on an env var otherwise means we sign one string and
       submit another — a guaranteed mismatch, and a miserable one to find. */
    for (const k of Object.keys(fields)) {
      if (fields[k] === null || fields[k] === undefined) { delete fields[k]; continue; }
      fields[k] = String(fields[k]).trim();
      if (fields[k] === '') delete fields[k];
    }

    fields.signature = sign(fields, process.env.PAYFAST_PASSPHRASE);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: PF_HOST, fields, txId })
    };

  } catch (e) {
    console.error('checkout error:', e);
    return fail(500, 'Could not start checkout. Try again in a moment.');
  }
};
