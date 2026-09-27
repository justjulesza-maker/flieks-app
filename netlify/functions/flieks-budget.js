/**
 * flieks-budget — Budget & call sheets (4flieks Lab).
 *
 * The page never touches the database: every read and write comes through
 * here, and this checks who is asking before it does anything (audit: the
 * server secret bypasses the rules, so each function checks the caller).
 *
 * POST { action, token?, ... }
 *   list                              my productions (titles only) + my limits
 *   get           { id }              one of my productions
 *   create        { production }      new production (id made here)
 *   save          { id, production }  replace one of mine (cleaned field by field)
 *   delete        { id }              remove it and unpublish its call sheets
 *   publish       { id, dayId }       publish / refresh a day's call sheet → { token }
 *   unpublish     { id, dayId }
 *   acks          { id, dayId }       who confirmed a published call sheet
 *   weather       { place, date }     forecast for a shoot day (Open-Meteo, looked up here)
 *   import-start  { fileBase64, fileName }   read a supplier quote PDF (AI) → { jobId }
 *   import-status { jobId }
 *   sheet         { t }               PUBLIC: a published call sheet by its link
 *   ack           { t, name }         PUBLIC: "Got it" on a call sheet (rate limited)
 *
 * Open to any Lab member; writing needs a verified email (filmmakers and admins always).
 *
 * Storage (all server-only; the rules deny the browser):
 *   flieks_budgets/<uid>/<id>            the production
 *   flieks_budget_index/<uid>/<id>       { title, type, updated_at } for the list
 *   flieks_callsheets/<token>            { owner, prod_id, day_id, sheet, published_at }
 *   flieks_callsheet_acks/<token>/<id>   { name, at }
 *   flieks_budget_jobs/<jobId>           AI quote import, polled by the owner, deleted once read
 *   flieks_lab_usage/<uid>/budget_imports/<jobId>   append-only usage ledger (audit H4)
 */
const crypto = require('crypto');
const ops = require('../lib/ops-core');
const core = require('../lib/budget-core');

const IMPORT_LIMIT = parseInt(process.env.BUDGET_IMPORT_LIMIT || '5', 10);   // per 30 days; admins and Lab unlimited exempt
const MAX_BASE64 = 5.5 * 1024 * 1024;                                         // ~4MB PDF; Netlify caps requests at 6MB
const MAX_STORED = 600 * 1024;                                                // one production, as JSON
const DAY = 864e5;

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  body: JSON.stringify(obj)
});
const importSecret = () => crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':budget-import').digest('hex');
const newId = (prefix, n) => prefix + crypto.randomBytes(n).toString('hex').slice(0, n);   // lowercase a-f0-9
const newToken = () => crypto.randomBytes(16).toString('hex');                          // 32 chars, 128 bits
const validId = v => typeof v === 'string' && core.ID.test(v);
const validToken = v => typeof v === 'string' && core.TOKEN.test(v);
const hour = () => new Date().toISOString().slice(0, 13).replace(/[-:T]/g, '');
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

async function lookup(token) {
  const key = process.env.FIREBASE_API_KEY;
  if (!token || typeof token !== 'string' || !key) return null;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token })
  });
  const u = ((await r.json().catch(() => ({}))).users || [])[0];
  if (!u || !validFirebaseUid(u.localId)) return null;
  const profile = await ops.dbGet(`flieks_users/${u.localId}`) || {};
  const role = profile.role || 'viewer';
  const unlimited = role === 'admin' || !!(await ops.dbGet(`flieks_lab_unlimited/${u.localId}`));
  return { uid: u.localId, role, verified: !!u.emailVerified, unlimited };
}
const validFirebaseUid = v => typeof v === 'string' && /^[A-Za-z0-9]{10,128}$/.test(v);
const canWrite = me => me.verified || me.role === 'filmmaker' || me.role === 'admin';
const clientIp = h => String(h['x-nf-client-connection-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();
const ipKey = h => crypto.createHash('sha256').update(clientIp(h) + ':' + String(process.env.FIREBASE_DB_SECRET)).digest('hex').slice(0, 20);

/* A counter that fails closed: if the database can't be reached, the request is refused (audit L8). */
const slot = (path, limit) => ops.takeSlot(path, limit).catch(() => false);

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { message: 'Bad request.' }); }
  if (!b || typeof b !== 'object') return reply(400, { message: 'Bad request.' });
  const h = event.headers || {};

  try {
    /* ---------- public: the shared call sheet ---------- */
    if (b.action === 'sheet') {
      if (!validToken(b.t)) return reply(404, { message: 'Call sheet not found.' });
      const rec = await ops.dbGet(`flieks_callsheets/${b.t}`);
      if (!rec || !rec.sheet) return reply(404, { message: 'Call sheet not found.' });
      return reply(200, { sheet: rec.sheet, published_at: rec.published_at || null });
    }
    if (b.action === 'ack') {
      if (!validToken(b.t)) return reply(404, { message: 'Call sheet not found.' });
      const name = core.str(b.name, 80);
      if (name.length < 2) return reply(400, { message: 'Add your name.' });
      if (!(await slot(`flieks_ops/budget_rate/ack_ip/${hour()}/${ipKey(h)}`, 20))) return reply(429, { message: 'Too many confirmations from here. Try again later.' });
      const rec = await ops.dbGet(`flieks_callsheets/${b.t}/owner`);
      if (!rec) return reply(404, { message: 'Call sheet not found.' });
      if (!(await slot(`flieks_ops/budget_rate/ack_sheet/${b.t}`, 300))) return reply(429, { message: 'This call sheet has all the confirmations it can take.' });
      await ops.dbWrite(`flieks_callsheet_acks/${b.t}/${newId('a', 16)}`, { name, at: Date.now() });
      return reply(200, { ok: true });
    }

    /* ---------- everything else is for signed-in members ---------- */
    const me = await lookup(b.token);
    if (!me) return reply(401, { message: 'Please sign in.' });
    const base = `flieks_budgets/${me.uid}`, index = `flieks_budget_index/${me.uid}`;
    const needWrite = () => canWrite(me) ? null
      : reply(403, { code: 'verify', message: 'Confirm your email first: open the link we sent you, then try again.' });

    if (b.action === 'list') {
      const idx = await ops.dbGet(index) || {};
      const ledger = await ops.dbGet(`flieks_lab_usage/${me.uid}/budget_imports`) || {};
      const since = Date.now() - 30 * DAY;
      const items = Object.entries(idx).filter(([k]) => validId(k)).map(([k, v]) => ({ id: k, title: v.title, type: v.type, updated_at: v.updated_at }))
        .sort((x, y) => (y.updated_at || 0) - (x.updated_at || 0));
      return reply(200, { items, verified: me.verified, role: me.role,
        imports: { limit: me.unlimited ? null : IMPORT_LIMIT, used: Object.values(ledger).filter(t => t >= since).length } });
    }

    if (b.action === 'get') {
      if (!validId(b.id)) return reply(400, { message: 'Bad id.' });
      const p = await ops.dbGet(`${base}/${b.id}`);
      if (!p) return reply(404, { message: 'Not found.' });
      return reply(200, { id: b.id, production: p });
    }

    if (b.action === 'create') {
      const stop = needWrite(); if (stop) return stop;
      const clean = core.cleanProduction(b.production, null);
      if (JSON.stringify(clean).length > MAX_STORED) return reply(413, { message: 'That production is too big to save.' });
      const pid = newId('p', 14), now = Date.now();
      let made;
      try {
        made = await ops.withLock(`budget_${me.uid}`, async () => {
          const idx = await ops.dbGet(index) || {};
          if (Object.keys(idx).length >= core.LIMITS.productions) return false;
          clean.created_at = now; clean.updated_at = now;
          await ops.dbWrite(`${base}/${pid}`, clean);
          await ops.dbWrite(`${index}/${pid}`, { title: clean.title, type: clean.type, updated_at: now });
          return true;
        });
      } catch (e) { if (e.busy) return reply(429, { message: 'Busy. Try again in a moment.' }); throw e; }
      if (!made) return reply(429, { message: `You can keep up to ${core.LIMITS.productions} productions. Delete one to start another.` });
      ops.logLabEvent('budget_create', me.uid, { format: clean.type });
      return reply(200, { id: pid, production: clean });
    }

    if (b.action === 'save') {
      const stop = needWrite(); if (stop) return stop;
      if (!validId(b.id)) return reply(400, { message: 'Bad id.' });
      if (!(await slot(`flieks_ops/budget_rate/save/${hour()}/${me.uid}`, 1500))) return reply(429, { message: 'Saving too often. Wait a minute.' });
      const prev = await ops.dbGet(`${base}/${b.id}`);
      if (!prev) return reply(404, { message: 'Not found.' });
      const clean = core.cleanProduction(b.production, prev);
      clean.created_at = Number(prev.created_at) || Date.now(); clean.updated_at = Date.now();
      if (JSON.stringify(clean).length > MAX_STORED) return reply(413, { message: 'That production is too big to save.' });
      const w = await ops.dbWrite(`${base}/${b.id}`, clean);
      if (w.status >= 400) throw new Error('save failed ' + w.status);
      await ops.dbWrite(`${index}/${b.id}`, { title: clean.title, type: clean.type, updated_at: clean.updated_at });
      // Days removed in this save: take their call sheets down too.
      const kept = new Set(clean.shootDays.map(d => d.token).filter(Boolean));
      for (const d of (prev.shootDays || [])) {
        if (d && validToken(d.token) && !kept.has(d.token)) await takeDown(d.token, me.uid);
      }
      return reply(200, { ok: true, updated_at: clean.updated_at, production: clean });
    }

    if (b.action === 'delete') {
      if (!validId(b.id)) return reply(400, { message: 'Bad id.' });
      const prev = await ops.dbGet(`${base}/${b.id}`);
      if (!prev) return reply(404, { message: 'Not found.' });
      for (const d of (prev.shootDays || [])) if (d && validToken(d.token)) await takeDown(d.token, me.uid);
      await ops.dbWrite(`${base}/${b.id}`, null);
      await ops.dbWrite(`${index}/${b.id}`, null);
      return reply(200, { ok: true });
    }

    if (b.action === 'publish' || b.action === 'unpublish' || b.action === 'acks') {
      if (!validId(b.id) || !validId(b.dayId)) return reply(400, { message: 'Bad id.' });
      const p = await ops.dbGet(`${base}/${b.id}`);
      if (!p) return reply(404, { message: 'Not found.' });
      const days = Array.isArray(p.shootDays) ? p.shootDays : [];
      const i = days.findIndex(d => d && d.id === b.dayId);
      if (i < 0) return reply(404, { message: 'That shoot day is gone. Refresh the page.' });
      const day = days[i];

      if (b.action === 'acks') {
        if (!validToken(day.token)) return reply(200, { items: [] });
        const a = await ops.dbGet(`flieks_callsheet_acks/${day.token}`) || {};
        return reply(200, { items: Object.values(a).map(x => ({ name: core.str(x && x.name, 80), at: Number(x && x.at) || 0 })).sort((x, y) => x.at - y.at) });
      }
      if (b.action === 'unpublish') {
        if (validToken(day.token)) await takeDown(day.token, me.uid);
        await ops.dbWrite(`${base}/${b.id}/shootDays/${i}/token`, '');
        return reply(200, { ok: true });
      }
      // publish
      const stop = needWrite(); if (stop) return stop;
      if (!me.unlimited && !(await slot(`flieks_ops/budget_rate/publish/${today()}/${me.uid}`, 100))) return reply(429, { message: 'That is a lot of publishing for one day. Try again tomorrow.' });
      const clean = core.cleanProduction(p, p);                       // stored data, cleaned again before it goes public
      const sheet = core.sheetFrom(clean, b.dayId);
      if (!sheet) return reply(404, { message: 'That shoot day is gone.' });
      let t = validToken(day.token) ? day.token : null;
      if (t) {
        const owner = await ops.dbGet(`flieks_callsheets/${t}/owner`);
        if (owner && owner !== me.uid) t = null;                       // never write over someone else's sheet
      }
      const first = !t;
      if (!t) t = newToken();
      await ops.dbWrite(`flieks_callsheets/${t}`, { owner: me.uid, prod_id: b.id, day_id: b.dayId, sheet, published_at: Date.now() });
      if (first) await ops.dbWrite(`${base}/${b.id}/shootDays/${i}/token`, t);
      if (first) ops.logLabEvent('callsheet_publish', me.uid, {});
      return reply(200, { token: t });
    }

    if (b.action === 'weather') {
      const stop = needWrite(); if (stop) return stop;
      const place = core.str(b.place, 80), date = String(b.date || '');
      if (place.length < 2 || !core.DATE.test(date)) return reply(400, { message: 'Add a town and a date.' });
      if (!(await slot(`flieks_ops/budget_rate/weather/${today()}/${me.uid}`, 60))) return reply(429, { message: 'Enough forecasts for today. Try again tomorrow.' });
      return reply(200, await forecast(place.split(',')[0].trim(), date));
    }

    if (b.action === 'import-start') {
      const stop = needWrite(); if (stop) return stop;
      const fileName = core.str(b.fileName, 120);
      if (typeof b.fileBase64 !== 'string' || !b.fileBase64) return reply(400, { message: 'Choose a PDF.' });
      if (!/\.pdf$/i.test(fileName)) return reply(400, { message: 'Upload the quote as a PDF.' });
      if (b.fileBase64.length > MAX_BASE64) return reply(413, { message: 'That PDF is too big (about 4MB at most). Split it and import the parts.' });
      if (!/^[A-Za-z0-9+/=\s]+$/.test(b.fileBase64.slice(0, 4000))) return reply(400, { message: 'That file could not be read.' });

      const jobId = newId('j', 20), nowTs = Date.now();
      // Count first, in an append-only ledger the member can't delete (audit H4), one request at a time.
      let allowed;
      try {
        allowed = await ops.withLock(`budgetimp_${me.uid}`, async () => {
          if (!me.unlimited) {
            const used = await ops.dbGet(`flieks_lab_usage/${me.uid}/budget_imports`) || {};
            if (Object.values(used).filter(t => t >= nowTs - 30 * DAY).length >= IMPORT_LIMIT) return false;
          }
          await ops.dbWrite(`flieks_lab_usage/${me.uid}/budget_imports/${jobId}`, nowTs);
          return true;
        });
      } catch (e) { if (e.busy) return reply(429, { message: 'Another import is starting. Try again in a moment.' }); throw e; }
      if (!allowed) return reply(429, { message: `You've used your ${IMPORT_LIMIT} quote imports for this month.` });

      await ops.dbWrite(`flieks_budget_jobs/${jobId}`, { owner: me.uid, status: 'queued', at: nowTs });
      const site = process.env.URL || 'https://4flieks.com';
      const kick = await fetch(`${site}/.netlify/functions/budget-import-background`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-job-secret': importSecret() },
        body: JSON.stringify({ jobId, owner: me.uid, fileBase64: b.fileBase64 })
      }).catch(() => ({ ok: false, status: 0 }));
      if (kick.status !== 202 && !kick.ok) {
        await ops.dbWrite(`flieks_budget_jobs/${jobId}`, { owner: me.uid, status: 'error', error: 'Could not start. Try again.', at: nowTs });
        return reply(502, { message: 'Could not start reading the quote. Try again.' });
      }
      ops.logLabEvent('budget_import', me.uid, {});
      return reply(200, { jobId });
    }

    if (b.action === 'import-status') {
      if (typeof b.jobId !== 'string' || !/^j[a-f0-9]{20}$/.test(b.jobId)) return reply(400, { message: 'Bad job.' });
      const job = await ops.dbGet(`flieks_budget_jobs/${b.jobId}`);
      if (!job || job.owner !== me.uid) return reply(404, { message: 'Not found.' });
      if (job.status === 'done' || job.status === 'error') await ops.dbWrite(`flieks_budget_jobs/${b.jobId}`, null);   // read once, then gone
      return reply(200, { status: job.status, error: job.status === 'error' ? (job.error || 'Could not read that quote.') : null,
        items: job.status === 'done' ? core.cleanImportItems(job.items) : null });
    }

    return reply(400, { message: 'Unknown action.' });
  } catch (e) {
    console.error('[flieks-budget]', b && b.action, e && e.message);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};

/* Remove a public call sheet, only if it belongs to this member. */
async function takeDown(t, uid) {
  const owner = await ops.dbGet(`flieks_callsheets/${t}/owner`).catch(() => null);
  if (owner && owner !== uid) return;
  await ops.dbWrite(`flieks_callsheets/${t}`, null);
  await ops.dbWrite(`flieks_callsheet_acks/${t}`, null);
}

/* Weather for a shoot day, looked up from here so the page needs no extra hosts in its security policy.
   Fixed hosts, encoded query: nothing from the request picks where this goes. */
const WMO = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 80: 'Showers', 81: 'Showers', 82: 'Heavy showers',
  95: 'Thunderstorms', 96: 'Thunderstorms & hail', 99: 'Thunderstorms & hail' };
async function forecast(place, date) {
  const diff = (Date.parse(date + 'T12:00:00Z') - Date.now()) / DAY;
  if (diff > 16) return { ok: false, message: 'Forecasts open 16 days before the shoot.' };
  if (diff < -60) return { ok: false, message: 'That date is too far back for a forecast.' };
  const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=5&language=en`).then(r => r.json()).catch(() => ({}));
  const hit = (g.results || []).find(r => r.country_code === 'ZA') || (g.results || [])[0];
  if (!hit || !Number.isFinite(hit.latitude) || !Number.isFinite(hit.longitude)) return { ok: false, message: `Couldn't find "${place}". Try a nearby town.` };
  const f = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}` +
    `&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset&timezone=auto&start_date=${date}&end_date=${date}`)
    .then(r => r.json()).catch(() => ({}));
  const x = f.daily;
  if (!x || !Array.isArray(x.time) || !x.time.length) return { ok: false, message: 'No forecast for that date yet.' };
  const hm = v => (String(v || '').slice(11, 16).match(/^\d{2}:\d{2}$/) || [''])[0];
  return { ok: true, weather: {
    summary: core.str(`${WMO[x.weathercode && x.weathercode[0]] || ''} · ${hit.name || place}`, 80),
    high: Math.round(Number(x.temperature_2m_max[0])), low: Math.round(Number(x.temperature_2m_min[0])),
    rain: Number.isFinite(Number(x.precipitation_probability_max && x.precipitation_probability_max[0])) ? Math.round(Number(x.precipitation_probability_max[0])) : '',
    sunrise: hm(x.sunrise && x.sunrise[0]), sunset: hm(x.sunset && x.sunset[0]) } };
}
