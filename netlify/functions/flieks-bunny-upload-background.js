/**
 * flieks-bunny-upload-background — moves a film's file into Bunny Stream.
 *
 * A background function because ordinary Netlify functions are killed at 26
 * seconds and a film takes longer than that. Background functions get 15
 * minutes and return 202 immediately, so the browser is not left waiting.
 *
 * Invoked by flieks-bunny; not called directly from the browser.
 *
 * POST { filmId, videoId, source, secret }
 */
const https = require('https');

const DB     = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET = process.env.FIREBASE_DB_SECRET;
const LIB    = (process.env.BUNNY_LIBRARY_ID || '').trim();
const BKEY   = (process.env.BUNNY_API_KEY || '').trim();

function dbPatch(path, data) {
  const b = JSON.stringify(data);
  const url = new URL(`${DB}/${path}.json?auth=${SECRET}`);
  return new Promise(resolve => {
    const r = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
    }, res => { res.resume(); res.on('end', resolve); });
    r.on('error', resolve);
    r.write(b); r.end();
  });
}

/* Streams the file through without buffering it — a feature would not fit in
   memory otherwise. */
function pipeToBunny(videoId, sourceUrl) {
  return new Promise(resolve => {
    https.get(sourceUrl, src => {
      if (src.statusCode !== 200) {
        src.resume();
        return resolve({ ok: false, detail: `source returned ${src.statusCode}` });
      }

      const size = Number(src.headers['content-length'] || 0);
      console.log('piping to Bunny', {
        videoId, bytes: size, mb: size ? +(size / 1048576).toFixed(1) : 'unknown'
      });

      let sent = 0, lastLog = Date.now();
      const started = Date.now();
      src.on('data', c => {
        sent += c.length;
        if (Date.now() - lastLog > 5000) {
          lastLog = Date.now();
          console.log(`  ${(sent / 1048576).toFixed(1)}MB sent${
            size ? ` of ${(size / 1048576).toFixed(1)}MB` : ''}`);
        }
      });
      src.on('end', () => {
        const secs = (Date.now() - started) / 1000;
        console.log('source stream ended', {
          bytesRead: sent,
          mb: +(sent / 1048576).toFixed(1),
          expectedMb: +(size / 1048576).toFixed(1),
          complete: size ? sent === size : 'unknown',
          seconds: +secs.toFixed(1),
          mbPerSec: +(sent / 1048576 / secs).toFixed(1)
        });
      });

      const up = https.request(
        `https://video.bunnycdn.com/library/${LIB}/videos/${videoId}`,
        {
          method: 'PUT',
          headers: {
            'AccessKey': BKEY,
            'Content-Type': 'application/octet-stream',
            ...(size ? { 'Content-Length': size } : {})
          }
        },
        res => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            console.log('Bunny upload finished', { status: res.statusCode, body });
            resolve({ ok: res.statusCode < 400, detail: `${res.statusCode} ${body}` });
          });
        }
      );

      up.on('error', e => resolve({ ok: false, detail: 'upload error: ' + e.message }));
      src.on('error', e => { up.destroy(); resolve({ ok: false, detail: 'source error: ' + e.message }); });
      src.pipe(up);

    }).on('error', e => resolve({ ok: false, detail: 'could not open source: ' + e.message }));
  });
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  const { filmId, videoId, source, secret } = JSON.parse(event.body || '{}');

  // Only our own function may call this.
  if (!secret || secret !== SECRET) return { statusCode: 403, body: 'Forbidden' };
  if (!filmId || !videoId || !source) return { statusCode: 400, body: 'Missing details' };

  console.log(`upload starting: ${filmId} -> ${videoId}`);
  const result = await pipeToBunny(videoId, source);

  await dbPatch(`flieks_private/${filmId}`, {
    bunny_upload_ok: result.ok,
    bunny_upload_detail: String(result.detail).slice(0, 300),
    bunny_upload_finished_at: Date.now()
  });

  // Ask Bunny what it actually has. A 200 on the upload does not guarantee the
  // bytes landed — that is exactly how the fetch endpoint misled us.
  await new Promise(r => setTimeout(r, 3000));
  const seen = await new Promise(resolve => {
    https.get(`https://video.bunnycdn.com/library/${LIB}/videos/${videoId}`,
      { headers: { 'AccessKey': BKEY, 'Accept': 'application/json' } }, res => {
        let b = ''; res.on('data', c => b += c);
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
      }).on('error', () => resolve({}));
  });

  console.log('Bunny reports', {
    status: seen.status,
    storageSize: seen.storageSize,
    mb: seen.storageSize ? +(seen.storageSize / 1048576).toFixed(1) : 0,
    length: seen.length,
    encodeProgress: seen.encodeProgress
  });

  console.log(`upload ${result.ok ? 'succeeded' : 'FAILED'}: ${filmId} — ${result.detail}`);
  return { statusCode: 200, body: 'done' };
};
