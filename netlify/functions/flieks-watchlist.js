/**
 * flieks-watchlist — save films for later, and "tell me when it's live".
 *
 * POST { action, token?, ... }
 *   list                          my saved films        -> { items: { filmId: { at } } }
 *   add     { filmId }            save a live or coming-soon film
 *   remove  { filmId }            take it off my list
 *   notify-email { filmId, email } signed out: email me when this coming-soon film is live (no token)
 *   counts  { filmIds? }          filmmaker: how many are waiting for my films; admin: any film
 *   last-run { filmId }           admin: the last "it's live" send for a film
 */
const ops = require('../lib/ops-core');
const wl = require('../lib/watchlist');

const EMAILS_PER_FILM_PER_DAY = parseInt(process.env.WATCH_EMAILS_PER_DAY || '2000', 10);

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

async function lookup(token) {
  const key = process.env.FIREBASE_API_KEY;
  if (!token || !key) return null;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token })
  });
  const u = ((await r.json().catch(() => ({}))).users || [])[0];
  if (!u) return null;
  const profile = await ops.dbGet(`flieks_users/${u.localId}`) || {};
  return { uid: u.localId, email: u.email || '', role: profile.role || 'viewer' };
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { message: 'Bad request.' }); }
  const a = b.action;
  try {
    /* ---- signed out: one email when a coming-soon film goes live ---- */
    if (a === 'notify-email') {
      if (!wl.okFilm(b.filmId)) return reply(404, { message: 'Film not found.' });
      const email = String(b.email || '').trim();
      if (!wl.validEmail(email)) return reply(400, { message: 'That email address doesn\'t look right.' });
      const film = await ops.dbGet(`flieks_films/${b.filmId}`);
      if (!film) return reply(404, { message: 'Film not found.' });
      if (film.status === 'live') return reply(200, { ok: true, live: true });
      if (film.status !== 'soon') return reply(404, { message: 'Film not found.' });
      const day = new Date(Date.now() + ops.SA).toISOString().slice(0, 10);
      const n = await ops.dbGet(`flieks_ops/watch_email_day/${b.filmId}/${day}`) || 0;
      if (n >= EMAILS_PER_FILM_PER_DAY) return reply(429, { message: 'Too many sign-ups today. Try again tomorrow.' });
      const key = wl.emailKey(email);
      const had = await ops.dbGet(`flieks_watch_emails/${b.filmId}/${key}`);
      if (!had) {
        await ops.dbWrite(`flieks_watch_emails/${b.filmId}/${key}`, { email, at: Date.now() });
        await ops.dbWrite(`flieks_ops/watch_email_day/${b.filmId}/${day}`, n + 1);
      }
      return reply(200, { ok: true });
    }

    const me = await lookup(b.token);
    if (!me) return reply(401, { message: 'Please sign in.' });

    if (a === 'list') {
      return reply(200, { items: await ops.dbGet(`flieks_watchlist/${me.uid}`) || {} });
    }

    if (a === 'add') {
      if (!wl.okFilm(b.filmId)) return reply(404, { message: 'Film not found.' });
      const film = await ops.dbGet(`flieks_films/${b.filmId}`);
      if (!wl.saveable(film)) return reply(404, { message: 'Film not found.' });
      const mine = await ops.dbGet(`flieks_watchlist/${me.uid}`) || {};
      if (!mine[b.filmId] && Object.keys(mine).length >= wl.MAX_ITEMS) {
        return reply(400, { message: `Your watchlist is full (${wl.MAX_ITEMS} films). Remove one first.` });
      }
      const at = (mine[b.filmId] && mine[b.filmId].at) || Date.now();
      await ops.dbWrite(`flieks_watchlist/${me.uid}/${b.filmId}`, { at });
      await ops.dbWrite(`flieks_watch_by_film/${b.filmId}/${me.uid}`, { at });
      return reply(200, { ok: true, at, soon: film.status === 'soon' });
    }

    if (a === 'remove') {
      if (!wl.okFilm(b.filmId)) return reply(404, { message: 'Film not found.' });
      await ops.dbWrite(`flieks_watchlist/${me.uid}/${b.filmId}`, null);
      await ops.dbWrite(`flieks_watch_by_film/${b.filmId}/${me.uid}`, null);
      return reply(200, { ok: true });
    }

    if (a === 'counts') {
      let ids = Array.isArray(b.filmIds) ? b.filmIds.filter(wl.okFilm).slice(0, 200) : [];
      if (me.role !== 'admin') {
        const films = await Promise.all(ids.map(id => ops.dbGet(`flieks_films/${id}`).then(f => [id, f])));
        ids = films.filter(([, f]) => f && f.filmmaker_uid === me.uid).map(([id]) => id);
      } else if (!ids.length) {
        ids = Object.keys(await ops.dbGet('flieks_watch_by_film') || {})
          .concat(Object.keys(await ops.dbGet('flieks_watch_emails') || {}));
        ids = [...new Set(ids)].filter(wl.okFilm);
      }
      return reply(200, { counts: await wl.counts(ids) });
    }

    if (a === 'last-run') {
      if (me.role !== 'admin' || !wl.okFilm(b.filmId)) return reply(403, { message: 'Admin only.' });
      return reply(200, { run: await ops.dbGet(`flieks_ops/watch_runs/${b.filmId}`) });
    }

    return reply(400, { message: 'Unknown action.' });
  } catch (e) {
    console.error('[watchlist]', a, e);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};
