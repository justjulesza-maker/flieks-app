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
 *
 * Trailer premieres (a big film's exclusive trailer, not for sale here):
 *   premiere-trailer { filmId }   the trailer link, once the premiere time has passed (no token)
 *   share   { filmId }            count a tap on Share (no token)
 *   premiere-save { filmId, on, premiere_at, release_line }   admin: set up / change / end a premiere
 *   premiere-remind { filmId }    admin: send "the trailer is out" now (it also goes automatically)
 *   send-update { filmId, subject, message, link }            admin: email everyone who asked
 *   premiere-report { filmId }    admin: a shareable results link for the film's team
 */
const crypto = require('crypto');
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

    /* ---- trailer premiere: the trailer only once the time has passed ---- */
    if (a === 'premiere-trailer') {
      if (!wl.okFilm(b.filmId)) return reply(404, { message: 'Film not found.' });
      const film = await ops.dbGet(`flieks_films/${b.filmId}`);
      if (!film || !film.premiere) return reply(404, { message: 'Film not found.' });
      if (film.premiere_at && film.premiere_at > Date.now()) return reply(403, { message: 'The trailer isn\'t out yet.', premiere_at: film.premiere_at });
      const priv = await ops.dbGet(`flieks_private/${b.filmId}`) || {};
      const url = priv.premiere_trailer || film.trailer_url;
      return url ? reply(200, { url }) : reply(404, { message: 'Trailer not yet available.' });
    }

    if (a === 'share') {
      if (!wl.okFilm(b.filmId)) return reply(404, { message: 'Film not found.' });
      const n = await ops.dbGet(`flieks_premiere_stats/${b.filmId}/shares`) || 0;
      await ops.dbWrite(`flieks_premiere_stats/${b.filmId}/shares`, n + 1);
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

    /* ---- admin: trailer premieres ---- */
    if (['premiere-save', 'premiere-remind', 'send-update', 'premiere-report'].includes(a)) {
      if (me.role !== 'admin') return reply(403, { message: 'Admin only.' });
      if (!wl.okFilm(b.filmId)) return reply(404, { message: 'Film not found.' });
      const film = await ops.dbGet(`flieks_films/${b.filmId}`);
      if (!film) return reply(404, { message: 'Film not found.' });

      if (a === 'premiere-save') {
        const priv = await ops.dbGet(`flieks_private/${b.filmId}`) || {};
        if (!b.on) {
          // End the premiere: the trailer goes back on the page as normal.
          await ops.dbWrite(`flieks_films/${b.filmId}`, { premiere: null, premiere_at: null, release_line: null, trailer_hidden: null,
            ...(priv.premiere_trailer ? { trailer_url: priv.premiere_trailer } : {}) }, 'PATCH');
          return reply(200, { ok: true, premiere: false });
        }
        if (film.status === 'live') return reply(400, { message: 'This film is on sale. A trailer premiere is for a film that isn\'t sold on 4flieks.' });
        const at = b.premiere_at ? Number(b.premiere_at) : null;
        if (at !== null && !(at > 1.6e12 && at < 2.2e12)) return reply(400, { message: 'That premiere time doesn\'t look right.' });
        const trailer = priv.premiere_trailer || film.trailer_url || null;
        if (!trailer) return reply(400, { message: 'Add the trailer first (the filmmaker uploads it, or put it on the film).' });
        // The trailer link is kept private and handed out only after the premiere time.
        await ops.dbWrite(`flieks_private/${b.filmId}/premiere_trailer`, trailer);
        await ops.dbWrite(`flieks_films/${b.filmId}`, {
          premiere: true, premiere_at: at, release_line: String(b.release_line || '').trim().slice(0, 80) || null,
          trailer_url: null, trailer_hidden: true, status: 'soon', awaiting_film: null
        }, 'PATCH');
        return reply(200, { ok: true, premiere: true, premiere_at: at });
      }

      if (a === 'premiere-remind') {
        if (!film.premiere) return reply(400, { message: 'Not a trailer premiere.' });
        if (film.premiere_at && film.premiere_at > Date.now()) return reply(400, { message: 'The trailer isn\'t out yet.' });
        const w = await wl.waiting(b.filmId);
        await ops.dbWrite(`flieks_ops/premiere_kicked/${b.filmId}`, { at: Date.now(), by: me.uid });
        const ok = await wl.startNotify(b.filmId, { kind: 'premiere' });
        return reply(ok ? 200 : 502, { ok, waiting: w.accounts.length + w.emails.length });
      }

      if (a === 'send-update') {
        const message = String(b.message || '').trim().slice(0, 2000);
        const subject = String(b.subject || '').trim().slice(0, 140);
        const link = String(b.link || '').trim().slice(0, 500);
        if (message.length < 10) return reply(400, { message: 'Write the message first.' });
        if (link && !/^https:\/\/\S+$/.test(link)) return reply(400, { message: 'The link must start with https://' });
        const w = await wl.waiting(b.filmId);
        const n = w.accounts.length + w.emails.length;
        if (!n) return reply(400, { message: 'Nobody has asked for news about this film yet.' });
        const updateId = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
        await ops.dbWrite(`flieks_ops/watch_updates/${b.filmId}/${updateId}`, { subject: subject || null, message, link: link || null, at: Date.now(), by: me.uid });
        const ok = await wl.startNotify(b.filmId, { kind: 'update', updateId });
        return reply(ok ? 200 : 502, { ok, waiting: n, updateId });
      }

      if (a === 'premiere-report') {
        let key = film.results_key;
        if (!key || !(await ops.dbGet(`flieks_result_keys/${key}`))) {
          key = crypto.randomBytes(12).toString('hex');
          await ops.dbWrite(`flieks_result_keys/${key}`, b.filmId);
        }
        await ops.dbWrite(`flieks_films/${b.filmId}`, { results_public: true, results_key: key, results_show_revenue: false }, 'PATCH');
        return reply(200, { ok: true, url: `${ops.SITE}/report/${key}` });
      }
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
