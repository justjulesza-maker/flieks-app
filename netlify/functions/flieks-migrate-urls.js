/**
 * flieks-migrate-urls — moves film video URLs out of the public catalogue.
 *
 * flieks_films is publicly readable, because the catalogue has to work for
 * signed-out visitors. Any video_url stored there can be read by anyone with a
 * browser console — no payment, no account. This moves them to flieks_private,
 * which only the server can read.
 *
 * Visit:
 *   /.netlify/functions/flieks-migrate-urls?key=YOUR_SETUP_PASSWORD          (dry run)
 *   /.netlify/functions/flieks-migrate-urls?key=YOUR_SETUP_PASSWORD&go=1     (do it)
 *
 * DELETE THIS FUNCTION once the migration is done.
 *
 * Environment variables:
 *   SETUP_PASSWORD, FIREBASE_DB_URL, FIREBASE_DB_SECRET
 */
const https = require('https');

const DB     = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET = process.env.FIREBASE_DB_SECRET;
const GUARD  = (process.env.SETUP_PASSWORD || '').trim();

function req(path, method, value) {
  const body = value === undefined ? null : JSON.stringify(value);
  const url = new URL(`${DB}/${path}.json?auth=${SECRET}`);
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method,
      headers: body ? { 'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body) } : {}
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(d ? JSON.parse(d) : null); } catch { resolve(null); } });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const page = html => ({
  statusCode: 200,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  body: `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;
 background:#0F0F0F;color:#EDEAE4}h1{font-size:20px}.muted{color:#8A8A8A;font-size:13px}
 table{width:100%;border-collapse:collapse;margin:18px 0;font-size:13px}
 th,td{text-align:left;padding:9px;border-bottom:1px solid #2A2A2A}
 th{color:#8A8A8A;font-weight:400;font-size:11px;letter-spacing:.1em;text-transform:uppercase}
 .ok{color:#5FD39B}.warn{color:#F0A62E}.bad{color:#FF7A6E}
 a.btn{display:inline-block;background:#F0A62E;color:#111;padding:12px 20px;border-radius:6px;
 text-decoration:none;font-weight:700;margin-top:14px}
 code{background:#1A1A1A;padding:2px 6px;border-radius:3px;font-size:12px}</style>${html}`
});

exports.handler = async event => {
  const q = event.queryStringParameters || {};
  if (!GUARD || q.key !== GUARD) return { statusCode: 403, body: 'Forbidden' };

  const films = (await req('flieks_films', 'GET')) || {};
  const ids = Object.keys(films);
  const go = q.go === '1';

  const rows = [];
  let moved = 0, already = 0, none = 0;

  for (const id of ids) {
    const f = films[id] || {};
    const priv = await req(`flieks_private/${id}`, 'GET');

    if (priv && priv.video_url) {
      rows.push([id, f.title || '', '<span class="ok">already private</span>']);
      already++;
      // Public copy left behind? Still needs clearing.
      if (f.video_url && go) {
        await req(`flieks_films/${id}/video_url`, 'DELETE');
        rows[rows.length - 1][2] = '<span class="ok">already private, public copy cleared</span>';
      }
      continue;
    }

    if (!f.video_url) {
      rows.push([id, f.title || '', '<span class="muted">no video uploaded</span>']);
      none++;
      continue;
    }

    if (go) {
      await req(`flieks_private/${id}`, 'PATCH', { video_url: f.video_url });
      const check = await req(`flieks_private/${id}`, 'GET');
      if (check && check.video_url === f.video_url) {
        await req(`flieks_films/${id}/video_url`, 'DELETE');
        rows.push([id, f.title || '', '<span class="ok">moved</span>']);
        moved++;
      } else {
        rows.push([id, f.title || '',
          '<span class="bad">copy failed — public value left alone</span>']);
      }
    } else {
      rows.push([id, f.title || '', '<span class="warn">would move</span>']);
      moved++;
    }
  }

  const table = `<table><tr><th>Film ID</th><th>Title</th><th>Status</th></tr>` +
    rows.map(r => `<tr><td><code>${r[0]}</code></td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('') +
    `</table>`;

  if (!go) {
    return page(`<h1>Move video URLs to private storage</h1>
      <p class="muted">Dry run — nothing has been changed.</p>
      ${table}
      <p><b>${moved}</b> to move &nbsp;·&nbsp; <b>${already}</b> already private
         &nbsp;·&nbsp; <b>${none}</b> with no video</p>
      <a class="btn" href="?key=${encodeURIComponent(q.key)}&go=1">Run the migration</a>
      <p class="muted" style="margin-top:20px">Each URL is copied to
      <code>flieks_private</code> and verified before the public copy is removed.
      Playback keeps working throughout — <code>flieks-play</code> reads the private
      node first and falls back to the public one.</p>`);
  }

  return page(`<h1 class="ok">Migration complete</h1>
    ${table}
    <p><b>${moved}</b> moved &nbsp;·&nbsp; <b>${already}</b> already private
       &nbsp;·&nbsp; <b>${none}</b> with no video</p>
    <p class="warn">Now delete this function from your repo.</p>
    <p class="muted">Test playback on a film you own before you do, just to be sure.</p>`);
};
