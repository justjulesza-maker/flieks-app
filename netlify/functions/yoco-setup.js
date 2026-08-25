/**
 * yoco-setup — registers the payment webhook with Yoco, from a browser.
 *
 * Yoco's dashboard doesn't expose webhook management, so this does it over
 * their API instead.
 *
 * Visit:
 *   /.netlify/functions/yoco-setup?key=YOUR_SETUP_PASSWORD
 *
 * It lists any webhooks already registered, registers ours if it isn't there,
 * and prints the signing secret — which Yoco shows exactly once.
 *
 * DELETE THIS FUNCTION once the webhook is registered. It can read and modify
 * your payment configuration and has no business staying deployed.
 *
 * Environment variables:
 *   YOCO_SECRET_KEY     sk_test_... or sk_live_...
 *   SETUP_PASSWORD      any string you choose; guards this endpoint
 */
const https = require('https');

const KEY   = (process.env.YOCO_SECRET_KEY || '').trim();
const GUARD = (process.env.SETUP_PASSWORD || '').trim();

function api(path, method, body) {
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request(`https://payments.yoco.com/api${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(d); } catch {}
        resolve({ status: res.statusCode, raw: d, json: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const page = html => ({
  statusCode: 200,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  body: `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<style>
 body{font:15px/1.6 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;
      background:#0F0F0F;color:#EDEAE4}
 h1{font-size:20px;margin-bottom:4px}
 .muted{color:#8A8A8A;font-size:13px;margin-bottom:24px}
 pre{background:#1A1A1A;border:1px solid #2A2A2A;border-radius:8px;padding:14px;
     overflow-x:auto;font-size:12.5px;line-height:1.55;white-space:pre-wrap;word-break:break-all}
 .secret{background:#2A1F0A;border:2px solid #F0A62E;border-radius:8px;padding:18px;margin:18px 0}
 .secret code{font-size:16px;color:#F0A62E;word-break:break-all;font-weight:700}
 .ok{color:#5FD39B}.bad{color:#FF7A6E}.warn{color:#F0A62E}
 h2{font-size:15px;margin:22px 0 8px}
</style>${html}`
});

exports.handler = async event => {
  const q = event.queryStringParameters || {};

  if (!GUARD) {
    return page('<h1 class="bad">SETUP_PASSWORD is not set</h1>' +
      '<p class="muted">Add it as a Netlify environment variable, redeploy, then reload this page.</p>');
  }
  if (q.key !== GUARD) {
    return { statusCode: 403, body: 'Forbidden' };
  }
  if (!KEY) {
    return page('<h1 class="bad">YOCO_SECRET_KEY is not set</h1>' +
      '<p class="muted">Add it as a Netlify environment variable and redeploy.</p>');
  }

  const mode = KEY.startsWith('sk_test') ? 'TEST' : 'LIVE';
  const site = (event.headers['x-forwarded-host'] || event.headers.host || '4flieks.com')
    .replace(/^https?:\/\//, '');
  const hookUrl = `https://${site}/.netlify/functions/yoco-webhook`;

  const existing = await api('/webhooks', 'GET');
  const list = (existing.json && (existing.json.subscriptions || existing.json)) || [];
  const already = Array.isArray(list) && list.some(w => w && w.url === hookUrl);

  let out = `<h1>Yoco webhook setup</h1>
    <p class="muted">Mode: <b class="warn">${mode}</b> &nbsp;·&nbsp; ${hookUrl}</p>
    <h2>Already registered</h2>
    <pre>${JSON.stringify(list, null, 2) || 'none'}</pre>`;

  if (already && q.force !== '1') {
    out += `<p class="ok">This URL is already registered for ${mode} mode.</p>
      <p class="muted">If you've lost the signing secret you'll need to delete it in Yoco and
      register again — the secret cannot be retrieved. To register a duplicate anyway,
      add <code>&amp;force=1</code>.</p>`;
    return page(out);
  }

  const created = await api('/webhooks', 'POST', {
    name: '4flieks payments',
    url: hookUrl
  });

  out += `<h2>Registration</h2><pre>HTTP ${created.status}\n${created.raw}</pre>`;

  const secret = created.json && (created.json.secret || created.json.signingSecret);
  if (secret) {
    out += `<div class="secret">
      <p style="margin:0 0 8px;font-size:13px">Add this to Netlify as
        <b>YOCO_WEBHOOK_SECRET</b>, then deploy without cache.</p>
      <code>${secret}</code>
      <p style="margin:10px 0 0;font-size:12px;color:#8A8A8A">
        Shown once. Copy it now — it cannot be retrieved later.</p>
    </div>
    <p class="warn">When that's done, delete this function from your repo.</p>`;
  } else if (created.status >= 400) {
    out += `<p class="bad">Registration failed. The response above should say why.</p>`;
  } else {
    out += `<p class="warn">Registered, but no secret field was returned — check the
      response above for where it appears.</p>`;
  }

  return page(out);
};
