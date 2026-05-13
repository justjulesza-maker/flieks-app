const crypto = require('crypto');
const https = require('https');

// ── ENV ──────────────────────────────────────────────────────────────────────
const PF_MERCHANT_ID  = process.env.PAYFAST_MERCHANT_ID;
const PF_MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY;
const PF_PASSPHRASE   = process.env.PAYFAST_PASSPHRASE || '';
const IS_SANDBOX      = process.env.PAYFAST_SANDBOX === 'true';
const FB_DB_URL       = process.env.FIREBASE_DB_URL;   // https://flieks-app-default-rtdb.firebaseio.com
const FB_SECRET       = process.env.FIREBASE_DB_SECRET; // Firebase DB legacy secret

// ── HELPERS ──────────────────────────────────────────────────────────────────
function buildSignatureString(data, includePassphrase = true) {
  const ordered = Object.keys(data)
    .filter(k => k !== 'signature' && data[k] !== '')
    .sort()
    .map(k => `${k}=${encodeURIComponent(data[k]).replace(/%20/g, '+')}`)
    .join('&');
  return includePassphrase && PF_PASSPHRASE
    ? `${ordered}&passphrase=${encodeURIComponent(PF_PASSPHRASE).replace(/%20/g, '+')}`
    : ordered;
}

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function firebaseWrite(path, value) {
  const url = `${FB_DB_URL}/${path}.json?auth=${FB_SECRET}`;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function firebaseIncrement(path, field) {
  // Read current value, increment, write back
  const readUrl = `${FB_DB_URL}/${path}/${field}.json?auth=${FB_SECRET}`;
  const current = await new Promise((resolve, reject) => {
    https.get(readUrl, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(parseInt(data) || 0));
    }).on('error', reject);
  });
  await firebaseWrite(`${path}/${field}`, current + 1);
}

// ── HANDLER ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // Parse body
    const params = new URLSearchParams(event.body);
    const data = Object.fromEntries(params.entries());

    console.log('PayFast ITN received:', JSON.stringify({
      payment_status: data.payment_status,
      pf_payment_id: data.pf_payment_id,
      amount_gross: data.amount_gross,
      custom_str1: data.custom_str1,
      custom_str2: data.custom_str2,
      custom_str3: data.custom_str3
    }));

    // 1. Verify signature
    const sigString = buildSignatureString(data);
    const expectedSig = md5(sigString);
    if (data.signature !== expectedSig) {
      console.error('Signature mismatch', { received: data.signature, expected: expectedSig });
      return { statusCode: 400, body: 'Invalid signature' };
    }

    // 2. Verify with PayFast servers
    const pfHost = IS_SANDBOX ? 'sandbox.payfast.co.za' : 'www.payfast.co.za';
    const verifyBody = new URLSearchParams(data).toString();
    const verifyResult = await httpsPost(`https://${pfHost}/eng/query/validate`, verifyBody);
    if (verifyResult.trim() !== 'VALID') {
      console.error('PayFast validation failed:', verifyResult);
      return { statusCode: 400, body: 'Payment validation failed' };
    }

    // 3. Check payment complete
    if (data.payment_status !== 'COMPLETE') {
      console.log('Payment not complete:', data.payment_status);
      return { statusCode: 200, body: 'Not complete' };
    }

    // 4. Extract custom fields
    const filmId = data.custom_str1;
    const type   = data.custom_str2; // 'rent' or 'own'
    const uid    = data.custom_str3;

    if (!filmId || !type || !uid) {
      console.error('Missing custom fields', { filmId, type, uid });
      return { statusCode: 400, body: 'Missing custom fields' };
    }

    const now       = Date.now();
    const expiresAt = type === 'rent' ? now + 48 * 60 * 60 * 1000 : null;

    // 5. Write purchase record
    await firebaseWrite(`flieks_purchases/${uid}/${filmId}`, {
      type,
      purchased_at: now,
      expires_at:   expiresAt,
      transaction_id: data.pf_payment_id,
      amount: parseFloat(data.amount_gross)
    });

    // 6. Increment film counter
    await firebaseIncrement(`flieks_films/${filmId}`, type === 'own' ? 'own_count' : 'rent_count');

    // 7. Write transaction log
    await firebaseWrite(`flieks_transactions/${data.pf_payment_id}`, {
      uid, filmId, type,
      amount: parseFloat(data.amount_gross),
      created_at: now,
      pf_payment_id: data.pf_payment_id,
      status: 'complete'
    });

    console.log(`✓ Purchase granted: ${uid} → ${filmId} (${type})`);
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('ITN handler error:', err);
    return { statusCode: 500, body: 'Internal error' };
  }
};
