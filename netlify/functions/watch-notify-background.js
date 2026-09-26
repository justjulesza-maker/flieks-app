/**
 * watch-notify-background — email everyone who saved a film, now that it is live.
 *
 * Started by flieks-film-live when an admin puts a film live (kind 'live'), by
 * flieks-ops-watch when a trailer premiere passes its time ('premiere'), and by an
 * admin sending news about a film ('update'). Needs the
 * x-job-secret header. Each person is emailed once per film (see lib/watchlist).
 */
const crypto = require('crypto');
const { notifyWatchers } = require('../lib/watchlist');

const secret = () => crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':watch-notify').digest('hex');

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  if (!process.env.FIREBASE_DB_SECRET || (event.headers || {})['x-job-secret'] !== secret()) return { statusCode: 403, body: 'no' };
  let filmId = '', kind = 'live', updateId = null;
  try { const b = JSON.parse(event.body || '{}'); filmId = String(b.filmId || ''); kind = b.kind || 'live'; updateId = b.updateId || null; } catch {}
  try {
    const r = await notifyWatchers(filmId, { kind, updateId });
    console.log('[watch-notify]', filmId, JSON.stringify(r));
  } catch (e) {
    console.error('[watch-notify]', filmId, e);
  }
  return { statusCode: 200, body: 'done' };
};
