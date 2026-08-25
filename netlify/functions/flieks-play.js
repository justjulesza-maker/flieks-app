/**
 * flieks-play — starts a rental's clock the first time it is played.
 *
 * A rental is written with expires_at: null. The window only begins when the
 * viewer actually presses play, so buying at 9am to watch that evening doesn't
 * cost them half their rental.
 *
 * Runs server-side because flieks_purchases is not client-writable.
 *
 * POST { token, filmId }
 *   -> { ok, type, expiresAt, hoursLeft }
 *   -> 403 if they have no access, or the rental has run out
 */
const https = require('https');

const DB      = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET  = process.env.FIREBASE_DB_SECRET;
const API_KEY = process.env.FIREBASE_API_KEY;

const RENTAL_HOURS = 48;

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
const dbPatch = (p, data) => {
  const b = JSON.stringify(data);
  return req(`${DB}/${p}.json?auth=${SECRET}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);
};

async function verifyToken(token) {
  if (!API_KEY) throw new Error('FIREBASE_API_KEY is not set on this site.');
  const b = JSON.stringify({ idToken: token });
  const r = await req(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);
  const d = JSON.parse(r.body || '{}');
  if (!d.users || !d.users[0]) throw new Error('bad token');
  return d.users[0];
}

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj)
});

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  try {
    const { token, filmId } = JSON.parse(event.body || '{}');
    if (!token || !filmId) return reply(400, { message: 'Missing details.' });

    const user = await verifyToken(token);
    const p = await dbGet(`flieks_purchases/${user.localId}/${filmId}`);

    if (!p) return reply(403, { message: 'You have not bought this film.' });

    const now = Date.now();

    /* The film's URL is only handed over once access is confirmed. It lives in
       flieks_private, which no client can read — flieks_films is public so the
       catalogue works signed out, and a URL in there is a URL anyone can take. */
    async function videoUrl() {
      const priv = await dbGet(`flieks_private/${filmId}`);
      if (priv && priv.video_url) return priv.video_url;
      // Fallback for films not yet migrated out of the public node.
      const film = await dbGet(`flieks_films/${filmId}`);
      return (film && film.video_url) || null;
    }

    /* Owned outright — nothing to time. */
    if (p.type !== 'rent') {
      return reply(200, { ok: true, type: p.type, expiresAt: null, url: await videoUrl() });
    }

    /* First play: start the clock now. */
    if (!p.expires_at) {
      const expiresAt = now + RENTAL_HOURS * 3600e3;
      await dbPatch(`flieks_purchases/${user.localId}/${filmId}`, {
        expires_at: expiresAt,
        first_played_at: now
      });
      console.log(`Rental started: ${user.localId} -> ${filmId}, ${RENTAL_HOURS}h`);
      return reply(200, {
        ok: true, type: 'rent', expiresAt, hoursLeft: RENTAL_HOURS, justStarted: true,
        url: await videoUrl()
      });
    }

    /* Already running. */
    if (now > p.expires_at) {
      return reply(403, { message: 'This rental has ended.', expired: true });
    }

    return reply(200, {
      ok: true, type: 'rent',
      expiresAt: p.expires_at,
      hoursLeft: Math.max(0, Math.round((p.expires_at - now) / 3600e3)),
      url: await videoUrl()
    });

  } catch (e) {
    console.error('play error:', e);
    return reply(500, { message: 'Could not start playback. Try again.' });
  }
};
