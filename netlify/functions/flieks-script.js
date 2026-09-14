/**
 * flieks-script — hands over a film's script, to anyone with an account.
 *
 * Deliberately not gated on buying the film. There is no repository of South
 * African screenplays anywhere, and the point of this is that someone studying
 * film can read them. An account is the bar, not a purchase.
 *
 * The file itself lives in flieks_private, so the URL is never in the public
 * catalogue — the same reasoning as the films.
 *
 * POST { token, filmSlug } -> { url, title, writer, pages, note }
 */
const https = require('https');

const DB      = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET  = process.env.FIREBASE_DB_SECRET;
const API_KEY = process.env.FIREBASE_API_KEY;

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
    const { token, filmSlug } = JSON.parse(event.body || '{}');
    if (!filmSlug) return reply(400, { message: 'Which script?' });

    if (!token) {
      return reply(401, {
        message: 'Scripts are for people with an account. Signing up is free — you do not have to buy the film.'
      });
    }

    const user = await verifyToken(token);

    const clean = String(filmSlug).replace(/[^a-z0-9-]/gi, '').slice(0, 80);
    const filmId = (await get(`flieks_film_slugs/${clean}`)) || clean;

    const film = await get(`flieks_films/${filmId}`);
    if (!film) return reply(404, { message: 'No such film.' });

    const priv = await get(`flieks_private/${filmId}`) || {};
    if (!priv.script_url || !film.script_public) {
      return reply(404, { message: 'There is no script for this film yet.' });
    }

    // Worth knowing which scripts get read — it is the case for building the
    // repository properly later.
    const reads = (film.script_reads || 0) + 1;
    await patch(`flieks_films/${filmId}`, { script_reads: reads });
    console.log(`Script read: ${filmId} by ${user.localId} (${reads} total)`);

    return reply(200, {
      url: priv.script_url,
      title: film.title || '',
      filmSlug: film.slug || filmId,
      writer: film.script_writer || film.filmmaker || '',
      draft: film.script_draft || '',
      pages: film.script_pages || null,
      language: film.language || '',
      minutes: film.duration_mins || null,
      reads
    });

  } catch (e) {
    if (String(e.message).includes('bad token')) {
      return reply(401, { message: 'Please sign in again.' });
    }
    console.error('script error:', e);
    return reply(500, { message: 'Could not open that.' });
  }
};
