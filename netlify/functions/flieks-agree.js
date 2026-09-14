/**
 * flieks-agree — records a filmmaker accepting the distribution agreement.
 *
 * Recorded here rather than in the browser so the timestamp, the IP and the
 * version of the terms cannot be set by whoever is signing. If this is ever
 * disputed, the record has to have come from us.
 *
 * Accepted once, covering the relationship. Each film added afterwards is a
 * schedule under it — asking someone to sign again for every short film would
 * be tedious and nobody would read it the second time.
 *
 * POST { token, action }
 *   status                          have I accepted, and is it current
 *   accept { fullName, capacity }   record acceptance
 *   signed { url }                  note that a countersigned PDF was uploaded
 */
const https = require('https');
const crypto = require('crypto');

const DB      = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET  = process.env.FIREBASE_DB_SECRET;
const API_KEY = process.env.FIREBASE_API_KEY;

/* Bump this when the agreement changes materially. Anyone on an older version
   is asked to accept again rather than being silently bound to new terms. */
const VERSION = '2026-09-12';

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

const get = async p => JSON.parse((await request(`${DB}/${p}.json?auth=${SECRET}`)).body || 'null');
const put = (p, data) => {
  const b = JSON.stringify(data);
  return request(`${DB}/${p}.json?auth=${SECRET}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);
};
const patch = (p, data) => {
  const b = JSON.stringify(data);
  return request(`${DB}/${p}.json?auth=${SECRET}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);
};

async function verifyToken(token) {
  if (!API_KEY) throw new Error('FIREBASE_API_KEY is not set.');
  const b = JSON.stringify({ idToken: token });
  const r = await request(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);
  const d = JSON.parse(r.body || '{}');
  if (!d.users || !d.users[0]) throw new Error('bad token');
  return d.users[0];
}

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  try {
    const { token, action } = JSON.parse(event.body || '{}');
    if (!token) return reply(401, { message: 'Please sign in.' });

    const user = await verifyToken(token);
    const uid = user.localId;
    const existing = await get(`flieks_agreements/${uid}`);

    /* ---- where do I stand ---- */
    if (action === 'status' || !action) {
      const current = !!(existing && existing.version === VERSION);
      return reply(200, {
        accepted: !!existing,
        current,
        version: VERSION,
        acceptedVersion: existing ? existing.version : null,
        acceptedAt: existing ? existing.accepted_at : null,
        name: existing ? existing.full_name : '',
        reference: existing ? existing.reference : null,
        hasSignedPdf: !!(existing && existing.signed_pdf_url)
      });
    }

    /* ---- accept it ---- */
    if (action === 'accept') {
      const { fullName, capacity } = JSON.parse(event.body || '{}');
      const name = String(fullName || '').trim().slice(0, 90);
      if (name.length < 3 || !name.includes(' ')) {
        return reply(400, { message: 'Please type your full name as you would sign it.' });
      }

      const h = event.headers || {};
      const ip = (h['x-nf-client-connection-ip'] ||
                  (h['x-forwarded-for'] || '').split(',')[0] || '').trim();

      const reference = 'DA-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const now = Date.now();

      await put(`flieks_agreements/${uid}`, {
        uid,
        reference,
        version: VERSION,
        full_name: name,
        capacity: String(capacity || '').trim().slice(0, 80),
        email: user.email || '',
        accepted_at: now,
        // Kept as evidence that the acceptance came from a real session.
        ip,
        user_agent: String(h['user-agent'] || '').slice(0, 200),
        method: 'electronic',
        // Carried over if they had signed a previous version.
        signed_pdf_url: (existing && existing.signed_pdf_url) || null
      });

      // So the admin user list shows it without a second lookup.
      await patch(`flieks_users/${uid}`, {
        agreement_version: VERSION,
        agreement_at: now,
        agreement_ref: reference
      });

      console.log(`Agreement accepted: ${uid} ${name} ${reference} v${VERSION}`);
      return reply(200, { ok: true, reference, version: VERSION, acceptedAt: now });
    }

    /* ---- they uploaded a countersigned copy as well ---- */
    if (action === 'signed') {
      const { url } = JSON.parse(event.body || '{}');
      if (!url || !/^https:\/\//.test(url)) return reply(400, { message: 'No file.' });
      if (!existing) return reply(400, { message: 'Accept the agreement first.' });
      await patch(`flieks_agreements/${uid}`, {
        signed_pdf_url: url, signed_pdf_at: Date.now()
      });
      return reply(200, { ok: true });
    }

    return reply(400, { message: 'Unknown action.' });

  } catch (e) {
    console.error('agreement error:', e);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};
