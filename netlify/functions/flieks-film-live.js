/**
 * flieks-film-live — email the filmmaker when their film goes live. Admin only.
 *
 * POST { token, filmId, force? }
 *   Sends once per film. force:true sends it again (the admin "Send go-live
 *   email" button).
 *   -> { ok, to, already?, watchers } or { ok:false, reason }
 *
 * It also starts watch-notify-background, which emails everyone who saved the
 * film ("tell me when it's live"). That runs every time and skips anyone
 * already emailed, so people who saved it since the last time still hear.
 */
const ops = require('../lib/ops-core');
const { sendLiveEmail } = require('../lib/film-mail');
const { waiting, startNotify } = require('../lib/watchlist');

/* Email the people waiting for this film, in the background. Returns how many are waiting. */
async function startWatchNotify(filmId) {
  const w = await waiting(filmId).catch(() => ({ accounts: [], emails: [] }));
  const n = w.accounts.length + w.emails.length;
  if (n) await startNotify(filmId, { kind: 'live' });
  return n;
}

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
  try {
    const { token, filmId, force } = JSON.parse(event.body || '{}');
    const admin = await ops.verifyAdmin(token);
    if (!admin) return reply(403, { message: 'Admin only.' });
    const r = await sendLiveEmail(String(filmId || ''), { force: !!force });
    console.log('[film-live]', filmId, r.ok ? (r.already ? 'already sent' : 'sent') : r.reason);
    const film = await ops.dbGet(`flieks_films/${String(filmId || '').replace(/[.#$\[\]\/]/g, '')}`).catch(() => null);
    const watchers = film && film.status === 'live' && !film.premiere ? await startWatchNotify(String(filmId)) : 0;
    return reply(200, { ...r, watchers });
  } catch (e) {
    console.error('[film-live]', e);
    return reply(500, { ok: false, reason: 'Could not send the email.' });
  }
};
