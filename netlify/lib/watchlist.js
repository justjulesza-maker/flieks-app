/**
 * watchlist — films people saved, and the "it's live" email when a saved film goes live.
 *
 * Where it lives (server-only; the functions read and write it):
 *   flieks_watchlist/{uid}/{filmId}          { at }            a viewer's own list
 *   flieks_watch_by_film/{filmId}/{uid}      { at }            who saved a film (for the email and counts)
 *   flieks_watch_emails/{filmId}/{key}       { email, at }     signed-out "tell me" sign-ups (coming-soon films)
 *   flieks_ops/watch_notified/{filmId}/{key} { at, ok }        who has had the "it's live" email for a film
 *   flieks_ops/watch_runs/{filmId}           { at, sent, ... } the last send for a film
 *
 * Each person gets the "it's live" email once per film, however many times the
 * film goes up and down. People who already bought the film are skipped.
 */
const crypto = require('crypto');
const ops = require('./ops-core');

const SITE = ops.SITE;
const REPLY_TO = process.env.SUPPORT_EMAIL || 'support@4flieks.com';
const MAX_ITEMS = 200;

const okFilm = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(id);
const validEmail = e => typeof e === 'string' && e.length <= 200 && /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i.test(e.trim());
const emailKey = e => 'e_' + crypto.createHash('sha256').update(String(e).trim().toLowerCase()).digest('hex').slice(0, 24);
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Films people may save: live now, or coming soon. */
const saveable = f => !!f && (f.status === 'live' || f.status === 'soon');

function whenText(date) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const d = new Date(date + 'T12:00:00Z');
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' });
}

/** The email a viewer gets when a film they saved is live. */
function liveNowEmail(film) {
  const title = film.title || 'A film you saved';
  const url = `${SITE}/${encodeURIComponent(film.slug || film.id)}`;
  const price = film.free ? 'Free to watch' : `Rent R${film.price_rent ?? 25} for 48 hours · Own R${film.price_own ?? 49}`;
  const by = [film.filmmaker, film.filmmaker_location].filter(Boolean).join(', ');
  const synopsis = String(film.synopsis || '').slice(0, 320);
  const subject = `${title} is live on 4flieks`;
  const text = [
    `${title} is live on 4flieks.`, '',
    by ? `A film by ${by}.` : '', synopsis, '',
    price, '', `Watch it here: ${url}`, '',
    'You asked us to tell you when this film was live. This is the only email about it.',
    '', '4flieks · African independent films'
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  const poster = /^https:\/\//.test(film.poster_url || '') ? film.poster_url : '';
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#F2EADA">
<div style="max-width:560px;margin:0 auto;padding:28px 18px;font-family:Arial,Helvetica,sans-serif;color:#1C1512">
  <div style="background:#1C1512;border-radius:14px;padding:22px 22px 18px">
    <img src="${SITE}/brand/png/logo-reversed-2x.png" width="220" alt="4flieks" style="display:block;width:220px;height:auto;border:0">
  </div>
  <p style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#B0441A;font-weight:700;margin:26px 0 6px">Now showing</p>
  <h1 style="font-size:28px;line-height:1.2;margin:0 0 8px">${escHtml(title)} is live</h1>
  ${by ? `<p style="font-size:15px;color:#54483F;margin:0 0 16px">A film by ${escHtml(by)}</p>` : ''}
  ${poster ? `<a href="${escHtml(url)}"><img src="${escHtml(poster)}" width="220" alt="${escHtml(title)}" style="display:block;width:220px;height:auto;border-radius:10px;border:0;margin:0 0 16px"></a>` : ''}
  ${synopsis ? `<p style="font-size:16px;line-height:1.55;margin:0 0 16px">${escHtml(synopsis)}</p>` : ''}
  <p style="font-size:15px;font-weight:700;margin:0 0 18px">${escHtml(price)}</p>
  <p style="margin:0 0 28px"><a href="${escHtml(url)}" style="display:inline-block;padding:14px 24px;border-radius:10px;font:700 16px/1 Arial,Helvetica,sans-serif;text-decoration:none;background:#D85A2C;color:#1C1512">Watch it now</a></p>
  <p style="font-size:13px;line-height:1.5;color:#6E6157;margin:0">You asked us to tell you when this film was live. This is the only email about it.</p>
  <p style="font-size:13px;color:#6E6157;margin:10px 0 0"><a href="${SITE}" style="color:#6E6157">4flieks.com</a> · African independent films</p>
</div></body></html>`;
  return { subject, text, html };
}

/* Resend's batch endpoint: up to 100 emails per call. */
async function sendBatch(msgs, fetchImpl = fetch) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: 'RESEND_API_KEY is not set' };
  const from = process.env.OPS_EMAIL_FROM || process.env.SUPPORT_FROM || '4flieks <support@4flieks.com>';
  const r = await fetchImpl('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(msgs.map(m => ({ from, reply_to: REPLY_TO, ...m, to: [m.to] })))
  });
  if (r.ok) return { ok: true };
  const why = await r.text().catch(() => '');
  return { ok: false, reason: `resend ${r.status}${why ? ': ' + why.slice(0, 160) : ''}` };
}

/** Who is waiting for a film: accounts that saved it and email sign-ups. */
async function waiting(filmId) {
  const [byFilm, emails] = await Promise.all([
    ops.dbGet(`flieks_watch_by_film/${filmId}`), ops.dbGet(`flieks_watch_emails/${filmId}`)
  ]);
  return { accounts: Object.keys(byFilm || {}), emails: Object.entries(emails || {}).map(([k, v]) => ({ key: k, email: v && v.email })) };
}

async function counts(filmIds) {
  const out = {};
  await Promise.all(filmIds.filter(okFilm).map(async id => {
    const w = await waiting(id);
    out[id] = { accounts: w.accounts.length, emails: w.emails.length, total: w.accounts.length + w.emails.length };
  }));
  return out;
}

/**
 * Email everyone waiting for a film that is now live. Safe to run again: anyone
 * already emailed for this film is skipped.
 */
async function notifyWatchers(filmId, { send = sendBatch, pauseMs = 600 } = {}) {
  if (!okFilm(filmId)) return { ok: false, reason: 'bad film id' };
  const film = await ops.dbGet(`flieks_films/${filmId}`);
  if (!film) return { ok: false, reason: 'film not found' };
  if (film.status !== 'live') return { ok: false, reason: 'the film is not live' };
  film.id = filmId;

  const [w, done] = await Promise.all([waiting(filmId), ops.dbGet(`flieks_ops/watch_notified/${filmId}`)]);
  const already = done || {};
  const seen = new Set();          // one email per address, even if saved twice
  const todo = [];
  let skipped = 0;
  for (const uid of w.accounts) {
    if (already[uid]) { skipped++; continue; }
    const [user, bought] = await Promise.all([ops.dbGet(`flieks_users/${uid}`), ops.dbGet(`flieks_purchases/${uid}/${filmId}`)]);
    const email = user && user.email;
    if (bought || !validEmail(email || '')) { skipped++; continue; }
    const k = emailKey(email);
    if (seen.has(k) || already[k]) { skipped++; continue; }
    seen.add(k); todo.push({ keys: [uid, k], email });
  }
  for (const { key, email } of w.emails) {
    if (already[key] || seen.has(key) || !validEmail(email || '')) { skipped++; continue; }
    seen.add(key); todo.push({ keys: [key], email });
  }

  const mail = liveNowEmail(film);
  let sent = 0, failed = 0, lastError = null;
  for (let i = 0; i < todo.length; i += 100) {
    const chunk = todo.slice(i, i + 100);
    const r = await send(chunk.map(t => ({ to: t.email, ...mail })));
    const at = Date.now(), marks = {};
    chunk.forEach(t => t.keys.forEach(k => { marks[k] = { at, ok: !!r.ok }; }));
    if (r.ok) { sent += chunk.length; await ops.dbWrite(`flieks_ops/watch_notified/${filmId}`, marks, 'PATCH'); }
    else { failed += chunk.length; lastError = r.reason; }
    if (i + 100 < todo.length && pauseMs) await new Promise(res => setTimeout(res, pauseMs));
  }
  const run = { at: Date.now(), waiting: w.accounts.length + w.emails.length, sent, skipped, failed, error: lastError };
  await ops.dbWrite(`flieks_ops/watch_runs/${filmId}`, run);
  return { ok: true, ...run };
}

module.exports = { okFilm, validEmail, emailKey, saveable, whenText, liveNowEmail, sendBatch, waiting, counts, notifyWatchers, MAX_ITEMS };
