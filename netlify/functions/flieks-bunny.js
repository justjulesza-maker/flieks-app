/**
 * flieks-bunny — moves a film's video into Bunny Stream, and reports on progress.
 *
 * Filmmakers keep uploading to Firebase Storage, which already works and gives
 * them resumable uploads with a progress bar. This then asks Bunny to fetch the
 * file, transcode it to adaptive bitrate, and serve it over their CDN.
 *
 * POST { token, filmId, action }
 *   action 'ingest' — hand the film to Bunny and record the video id
 *   action 'status' — how far along the transcode is
 *
 * Admin and the film's own filmmaker only.
 *
 * Environment variables:
 *   BUNNY_LIBRARY_ID, BUNNY_API_KEY
 *   FIREBASE_DB_URL, FIREBASE_DB_SECRET, FIREBASE_API_KEY
 */
const https = require('https');

const DB      = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET  = process.env.FIREBASE_DB_SECRET;
const API_KEY = process.env.FIREBASE_API_KEY;
const LIB     = (process.env.BUNNY_LIBRARY_ID || '').trim();
const BKEY    = (process.env.BUNNY_API_KEY || '').trim();

/* Bunny's own status codes for a video. */
const STATUS = {
  0: 'queued', 1: 'processing', 2: 'processing', 3: 'processing',
  4: 'ready', 5: 'failed', 6: 'presigned upload', 7: 'transcoding'
};

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

const dbGet   = async p => JSON.parse((await req(`${DB}/${p}.json?auth=${SECRET}`)).body || 'null');
const dbPatch = (p, data) => {
  const b = JSON.stringify(data);
  return req(`${DB}/${p}.json?auth=${SECRET}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);
};

function bunny(path, method, body) {
  const data = body ? JSON.stringify(body) : null;
  return req(`https://video.bunnycdn.com/library/${LIB}${path}`, {
    method,
    headers: {
      'AccessKey': BKEY,
      'Accept': 'application/json',
      ...(data ? { 'Content-Type': 'application/json',
                   'Content-Length': Buffer.byteLength(data) } : {})
    }
  }, data);
}

async function verifyToken(token) {
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
    if (!LIB || !BKEY) return reply(500, { message: 'Bunny Stream is not configured.' });

    const { token, filmId, action } = JSON.parse(event.body || '{}');
    if (!token || !filmId) return reply(400, { message: 'Missing details.' });

    const user = await verifyToken(token);
    const [profile, film] = await Promise.all([
      dbGet(`flieks_users/${user.localId}`),
      dbGet(`flieks_films/${filmId}`)
    ]);

    if (!film) return reply(404, { message: 'No such film.' });

    const isAdmin = profile && profile.role === 'admin';
    const isOwner = film.filmmaker_uid === user.localId;
    if (!isAdmin && !isOwner) return reply(403, { message: 'Not your film.' });

    const priv = await dbGet(`flieks_private/${filmId}`) || {};

    /* ---- how is the transcode going? ---- */
    if (action === 'status') {
      if (!priv.bunny_id) return reply(200, { state: 'not started' });
      const r = await bunny(`/videos/${priv.bunny_id}`, 'GET');
      let v = {};
      try { v = JSON.parse(r.body || '{}'); } catch {}
      let state = STATUS[v.status] || 'unknown';
      // Bunny reports "processing" even when the fetch never delivered anything.
      // A video with no bytes several minutes after starting has stalled.
      const started = priv.bunny_started_at || 0;
      if (state !== 'ready' && state !== 'failed' &&
          (v.storageSize === 0 || v.length === 0) &&
          started && Date.now() - started > 3 * 60 * 1000) {
        state = 'stalled';
      }
      if (state === 'ready' && !priv.bunny_ready) {
        await dbPatch(`flieks_private/${filmId}`, { bunny_ready: true });
      }
      return reply(200, {
        state,
        progress: v.encodeProgress ?? null,
        length: v.length ?? null,
        bytes: v.storageSize ?? null,
        bunnyId: priv.bunny_id
      });
    }

    /* ---- remove a failed or unwanted Bunny copy ---- */
    if (action === 'reset') {
      if (priv.bunny_id) await bunny(`/videos/${priv.bunny_id}`, 'DELETE');
      await dbPatch(`flieks_private/${filmId}`, {
        bunny_id: null, bunny_ready: null, bunny_started_at: null
      });
      return reply(200, { ok: true, message: 'Cleared. You can prepare it again.' });
    }

    /* ---- hand it to Bunny ---- */
    if (priv.bunny_id) {
      return reply(200, { message: 'Already sent to Bunny.', bunnyId: priv.bunny_id });
    }

    const source = priv.video_url;
    if (!source) return reply(400, { message: 'This film has no video uploaded yet.' });

    // 1 — create the video object
    const made = await bunny('/videos', 'POST', { title: film.title || filmId });
    let created = {};
    try { created = JSON.parse(made.body || '{}'); } catch {}
    if (made.status >= 400 || !created.guid) {
      console.error('Bunny create failed', made.status, made.body);
      return reply(502, { message: 'Bunny would not accept the video.' });
    }

    // 2 — tell Bunny to go and fetch the file from Firebase
    const fetched = await bunny(`/videos/${created.guid}/fetch`, 'POST', { url: source });
    let fetchBody = {};
    try { fetchBody = JSON.parse(fetched.body || '{}'); } catch {}

    console.log('Bunny fetch response', {
      httpStatus: fetched.status,
      body: fetched.body,
      sourceLength: source.length,
      sourceHost: (source.split('/')[2] || '')
    });

    // Bunny answers 200 with success:false when it cannot reach the file,
    // so the status code alone is not enough to tell whether it worked.
    const fetchOk = fetched.status < 400 &&
                    fetchBody.success !== false &&
                    fetchBody.statusCode !== 400;

    if (!fetchOk) {
      // Don't leave an empty video object behind.
      await bunny(`/videos/${created.guid}`, 'DELETE');
      return reply(502, {
        message: fetchBody.message || 'Bunny could not download the file.',
        bunnySaid: fetched.body,
        httpStatus: fetched.status
      });
    }

    await dbPatch(`flieks_private/${filmId}`, {
      bunny_id: created.guid,
      bunny_ready: false,
      bunny_started_at: Date.now()
    });

    console.log(`Bunny ingest started: ${filmId} -> ${created.guid}`);
    return reply(200, {
      ok: true,
      bunnyId: created.guid,
      message: 'Sent to Bunny. Transcoding usually takes a few minutes.'
    });

  } catch (e) {
    console.error('bunny error:', e);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};
