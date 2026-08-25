/**
 * flieks-bunny-token-test — works out which token format Bunny accepts.
 *
 * Bunny documents several signing schemes and it is not obvious which applies
 * to a Stream library. Rather than guess again, this builds every plausible
 * variant, tries each against Bunny, and reports which returned 200.
 *
 * Visit:
 *   /.netlify/functions/flieks-bunny-token-test?key=YOUR_SETUP_PASSWORD&video=VIDEO_ID
 *
 * DELETE THIS FUNCTION once the right format is known.
 */
const crypto = require('crypto');
const https  = require('https');

const HOST  = (process.env.BUNNY_CDN_HOSTNAME || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
const TOKEN = (process.env.BUNNY_TOKEN_KEY || '').trim();
const GUARD = (process.env.SETUP_PASSWORD || '').trim();

const b64url = buf => buf.toString('base64')
  .replace(/\n/g, '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

const sha = s => crypto.createHash('sha256').update(s).digest();

function variants(videoId, expires) {
  const file = `/${videoId}/playlist.m3u8`;
  const dir  = `/${videoId}/`;
  const out = [];

  // 1 — CDN directory token, base64url. The usual choice for HLS, because a
  //     file token would sign the playlist but none of its segments.
  out.push({
    name: 'directory token, base64url',
    url: `https://${HOST}${file}?token=${b64url(sha(TOKEN + dir + expires))}` +
         `&expires=${expires}&token_path=${encodeURIComponent(dir)}`
  });

  // 2 — same, but signing the file path rather than the directory
  out.push({
    name: 'file path, base64url',
    url: `https://${HOST}${file}?token=${b64url(sha(TOKEN + file + expires))}&expires=${expires}`
  });

  // 3 — hex rather than base64, file path
  out.push({
    name: 'file path, hex',
    url: `https://${HOST}${file}?token=${sha(TOKEN + file + expires).toString('hex')}&expires=${expires}`
  });

  // 4 — hex, directory path, with token_path
  out.push({
    name: 'directory token, hex',
    url: `https://${HOST}${file}?token=${sha(TOKEN + dir + expires).toString('hex')}` +
         `&expires=${expires}&token_path=${encodeURIComponent(dir)}`
  });

  // 5 — Stream style: key + videoId + expiry, hex. What we have deployed.
  out.push({
    name: 'videoId only, hex (currently deployed)',
    url: `https://${HOST}${file}?token=${sha(TOKEN + videoId + expires).toString('hex')}&expires=${expires}`
  });

  // 6 — Stream style, base64url
  out.push({
    name: 'videoId only, base64url',
    url: `https://${HOST}${file}?token=${b64url(sha(TOKEN + videoId + expires))}&expires=${expires}`
  });

  // 7 — no token at all. If this plays, token authentication is switched off
  //     in the library and none of the signing matters yet.
  out.push({ name: 'no token at all', url: `https://${HOST}${file}` });

  return out;
}

function tryUrl(url) {
  return new Promise(resolve => {
    https.get(url, res => {
      let body = '';
      res.on('data', c => { if (body.length < 300) body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 200) }));
    }).on('error', e => resolve({ status: 0, body: e.message }));
  });
}

exports.handler = async event => {
  const q = event.queryStringParameters || {};
  if (!GUARD || q.key !== GUARD) return { statusCode: 403, body: 'Forbidden' };

  const videoId = q.video;
  if (!videoId) {
    return { statusCode: 400, body: 'Add &video=YOUR_VIDEO_ID' };
  }

  const expires = Math.floor(Date.now() / 1000) + 3600;
  const list = variants(videoId, expires);

  const results = [];
  for (const v of list) {
    const r = await tryUrl(v.url);
    results.push({ ...v, ...r });
  }

  const winner = results.find(r => r.status === 200);

  const rows = results.map(r => `
    <tr>
      <td>${r.name}</td>
      <td class="${r.status === 200 ? 'ok' : 'bad'}">${r.status}</td>
      <td><a href="${r.url}" target="_blank">open</a></td>
    </tr>`).join('');

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;
 background:#0F0F0F;color:#EDEAE4}h1{font-size:20px}table{width:100%;border-collapse:collapse;margin:20px 0}
 th,td{text-align:left;padding:10px;border-bottom:1px solid #2A2A2A;font-size:13px}
 th{color:#8A8A8A;font-weight:400;font-size:11px;letter-spacing:.1em;text-transform:uppercase}
 .ok{color:#5FD39B;font-weight:700}.bad{color:#FF7A6E}
 a{color:#F0A62E}code{background:#1A1A1A;padding:2px 6px;border-radius:3px;font-size:12px;word-break:break-all}
 .box{background:#1A1A1A;border-left:3px solid #F0A62E;padding:14px 16px;margin:18px 0}
 .muted{color:#8A8A8A;font-size:13px}</style>
<h1>Which token format does Bunny accept?</h1>
<p class="muted">Library host <code>${HOST}</code> · video <code>${videoId}</code> ·
 token key ${TOKEN ? 'set' : '<span class="bad">NOT SET</span>'}</p>
<table><tr><th>Format</th><th>Result</th><th></th></tr>${rows}</table>
${winner
  ? `<div class="box"><p><b class="ok">${winner.name}</b> is the one Bunny accepts.
     Tell me which and I'll set it in flieks-play.</p></div>`
  : `<div class="box"><p class="bad">None returned 200.</p>
     <p class="muted">If even "no token at all" failed, the video may still be transcoding,
     or the hostname is wrong. If only that one worked, token authentication is off in the
     library's Security tab.</p></div>`}
<p class="muted">Delete this function once you have the answer.</p>`
  };
};
