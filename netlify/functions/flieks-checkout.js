/**
 * flieks-checkout — creates a Yoco checkout and returns the redirect URL.
 *
 * The browser sends only { filmId, type }. The price is read from the database
 * here, so it cannot be tampered with in devtools.
 *
 * POST { token, filmId, type, giftTo?, giftMsg?, ref?, returnUrl? }
 *   -> { redirectUrl, txId }
 *
 * Netlify environment variables:
 *   YOCO_SECRET_KEY      sk_test_... while testing, sk_live_... in production
 *   FIREBASE_DB_URL
 *   FIREBASE_DB_SECRET
 *   FIREBASE_API_KEY
 */
const https = require('https');

const DB      = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET  = process.env.FIREBASE_DB_SECRET;
const API_KEY = process.env.FIREBASE_API_KEY;
const YOCO    = (process.env.YOCO_SECRET_KEY || '').trim();

const VAT_RATE = 0.15;

/* ── plumbing ─────────────────────────────────────────────────────────────── */

function request(url, opts = {}, body = null) {
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
  const r = await request(`${DB}/${path}.json?auth=${SECRET}`);
  return JSON.parse(r.body || 'null');
};

const dbPut = async (path, data) => {
  const b = JSON.stringify(data);
  return request(`${DB}/${path}.json?auth=${SECRET}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);
};

async function verifyToken(token) {
  if (!API_KEY) throw new Error('FIREBASE_API_KEY is not set on this site.');
  const b = JSON.stringify({ idToken: token });
  const r = await request(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);
  const d = JSON.parse(r.body || '{}');
  if (!d.users || !d.users[0]) {
    const reason = (d.error && d.error.message) || 'no user returned';
    throw new Error('bad token: ' + reason);
  }
  return d.users[0];
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
    if (!YOCO) return fail(500, 'Payments are not configured yet.');

    const { token, filmId, type, giftTo, giftMsg, ref, returnUrl } =
      JSON.parse(event.body || '{}');

    if (!token || !filmId || !['rent', 'own', 'gift'].includes(type)) {
      return fail(400, 'Missing or invalid request.');
    }

    // "Who's it for" is a name, not an email.
    if (type === 'gift' && giftTo && /\S+@\S+\.\S+/.test(giftTo)) {
      return fail(400, "Use their name, not an email — you'll get a code to send them.");
    }

    const user = await verifyToken(token);
    const film = await dbGet(`flieks_films/${filmId}`);

    if (!film) return fail(404, 'That film could not be found.');
    if (film.status !== 'live') return fail(403, 'That film is not on sale.');

    /* Price comes from the database, never the browser. Listed prices are
       VAT-inclusive, so VAT is extracted from the total rather than added. */
    const total = type === 'rent' ? Number(film.price_rent) : Number(film.price_own);
    if (!(total > 0)) return fail(400, 'That film has no price set.');

    const vat  = +(total - total / (1 + VAT_RATE)).toFixed(2);
    const base = +(total - vat).toFixed(2);
    const cents = Math.round(total * 100);      // Yoco works in cents

    /* Don't charge someone twice for the same thing. */
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
    const label = type === 'own' ? 'Own' : type === 'gift' ? 'Gift' : '48-hour rental';

    /* Park the intent before sending them off to pay. */
    await dbPut(`flieks_transactions/${txId}`, {
      uid: user.localId,
      email: user.email || '',
      film_id: filmId,
      film_title: film.title || '',
      type,
      amount: base,
      vat,
      total,
      platform_fee:    +(base * 0.30).toFixed(2),   // split on the ex-VAT amount
      filmmaker_share: +(base * 0.70).toFixed(2),
      filmmaker_uid: film.filmmaker_uid || null,
      ref: ref || null,
      gift_to:  type === 'gift' ? String(giftTo  || '').slice(0, 80)  : null,
      gift_msg: type === 'gift' ? String(giftMsg || '').slice(0, 300) : null,
      gateway: 'yoco',
      status: 'pending',
      created_at: Date.now()
    });

    /* Create the Yoco checkout. */
    const payload = JSON.stringify({
      amount: cents,
      currency: 'ZAR',
      successUrl: `${origin}/?payment=success&tx=${txId}`,
      cancelUrl:  `${origin}/?payment=cancel`,
      failureUrl: `${origin}/?payment=failed&tx=${txId}`,
      // Comes straight back on the webhook, so the ITN knows what was bought.
      metadata: {
        txId,
        filmId,
        type,
        uid: user.localId,
        ref: ref || ''
      },
      lineItems: [{
        displayName: `${film.title || filmId} — ${label}`,
        quantity: 1,
        pricingDetails: { price: cents }
      }],
      totalTaxAmount: Math.round(vat * 100),
      subtotalAmount: Math.round(base * 100)
    });

    const res = await request('https://payments.yoco.com/api/checkouts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${YOCO}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        // Stops a retry after a network timeout creating a second charge.
        'Idempotency-Key': txId
      }
    }, payload);

    let checkout = {};
    try { checkout = JSON.parse(res.body || '{}'); } catch {}

    if (res.status >= 400 || !checkout.redirectUrl) {
      console.error('Yoco checkout failed', {
        status: res.status,
        body: res.body,
        mode: YOCO.startsWith('sk_test') ? 'test' : 'live'
      });
      return fail(502, checkout.message || 'Could not start checkout. Please try again.');
    }

    // Keep the checkout id so the webhook can be tied back to this transaction.
    await request(`${DB}/flieks_transactions/${txId}.json?auth=${SECRET}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ checkout_id: checkout.id || null }));

    console.log('checkout created:', {
      txId, type, filmId,
      mode: YOCO.startsWith('sk_test') ? 'test' : 'live',
      amount: `R${total.toFixed(2)}`,
      checkoutId: checkout.id
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirectUrl: checkout.redirectUrl, txId })
    };

  } catch (e) {
    console.error('checkout error:', e);
    return fail(500, 'Could not start checkout. Try again in a moment.');
  }
};
