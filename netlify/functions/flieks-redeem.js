/**
 * flieks-redeem — claims a gift code and grants access to that film.
 *
 * Runs server-side with the database secret so flieks_purchases stays
 * unwritable by clients. Deploy to netlify/functions/flieks-redeem.js
 *
 * POST { token, code } -> { ok:true, filmId }
 */
const https = require('https');

const DB      = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET  = process.env.FIREBASE_DB_SECRET;
const API_KEY = process.env.FIREBASE_API_KEY;

function req(url, opts = {}, body = null) {
  return new Promise((res, rej) => {
    const r = https.request(url, opts, x => {
      let d = ''; x.on('data', c => d += c);
      x.on('end', () => res({ status: x.statusCode, body: d }));
    });
    r.on('error', rej); if (body) r.write(body); r.end();
  });
}
const dbGet = async p => JSON.parse((await req(`${DB}/${p}.json?auth=${SECRET}`)).body || 'null');
const dbWrite = (p, data, method) => {
  const b = JSON.stringify(data);
  return req(`${DB}/${p}.json?auth=${SECRET}`,
    { method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } }, b);
};

async function verify(token) {
  const b = JSON.stringify({ idToken: token });
  const r = await req(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } }, b);
  const d = JSON.parse(r.body || '{}');
  if (!d.users || !d.users[0]) throw new Error('bad token');
  return d.users[0];
}

const fail = (code, message) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message })
});

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  try {
    const { token, code } = JSON.parse(event.body || '{}');
    if (!token || !code) return fail(400, 'Missing code.');

    const user = await verify(token);
    const key  = String(code).trim().toUpperCase();
    const gift = await dbGet(`flieks_gifts/${encodeURIComponent(key)}`);

    if (!gift) return fail(404, 'No gift with that code.');

    const now = Date.now();
    if (gift.expiresAt && now > gift.expiresAt) return fail(410, 'That code has expired.');

    if (gift.multiUse) {
      if (gift.claims && gift.claims[user.localId]) return fail(409, 'You already unlocked this one.');
      if (gift.maxUses && Object.keys(gift.claims || {}).length >= gift.maxUses) {
        return fail(409, 'That code has reached its limit.');
      }
    } else {
      if (gift.claimedBy === user.localId) return fail(409, 'You already unlocked this one.');
      if (gift.claimedBy)                  return fail(409, 'That code has already been used.');
    }

    const filmId = gift.filmId;
    if (!filmId) return fail(500, 'That code is not attached to a film.');

    await dbWrite(`flieks_purchases/${user.localId}/${filmId}`, {
      film_id: filmId,
      uid: user.localId,
      type: 'own',
      amount: gift.amount || 0,
      source: 'gift',
      gift_code: key,
      ref: gift.ref || null,
      expires_at: null,
      created_at: now,
      status: 'complete'
    }, 'PUT');

    if (gift.multiUse) {
      await dbWrite(`flieks_gifts/${encodeURIComponent(key)}/claims/${user.localId}`,
        { email: user.email || '', at: now }, 'PUT');
    } else {
      await dbWrite(`flieks_gifts/${encodeURIComponent(key)}`, {
        claimedBy: user.localId, claimedEmail: user.email || '', claimedAt: now
      }, 'PATCH');
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, filmId })
    };
  } catch (e) {
    return fail(500, 'Could not redeem right now.');
  }
};
