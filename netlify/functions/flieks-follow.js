/**
 * flieks-follow — filmmakers' public pages (4flieks.com/by/<slug>) and following.
 *
 * GET  ?slug=x                         a page, for link previews
 * POST { action: 'page', slug | uid }  a page (no sign-in)
 * POST { action: 'follow' | 'unfollow', token, slug }
 * POST { action: 'mine', token }       who I follow
 * POST { action: 'my-page', token }    filmmaker: my page and follower count
 * POST { action: 'save-page', token, page: { name, location, bio, instagram, website } }
 * POST { action: 'announce', token, filmId }   admin: tell followers about a coming-soon film
 */
const ops = require('../lib/ops-core');
const mk = require('../lib/makers');
const wl = require('../lib/watchlist');

const MAX_FOLLOWS = 500;

const reply = (code, obj, cache) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': cache ? 'public, max-age=60' : 'no-store' },
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
  try {
    if (event.httpMethod === 'GET') {
      const uid = await mk.uidFromSlug((event.queryStringParameters || {}).slug || '');
      const page = uid ? await mk.publicPage(uid) : null;
      return page ? reply(200, { page }, true) : reply(404, { message: 'Not found.' }, true);
    }
    if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
    let b;
    try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { message: 'Bad request.' }); }
    const a = b.action;

    if (a === 'page') {
      const uid = b.uid && mk.okUid(b.uid) ? b.uid : await mk.uidFromSlug(b.slug || '');
      const page = uid ? await mk.publicPage(uid) : null;
      return page ? reply(200, { page }) : reply(404, { message: 'This filmmaker has no films on 4flieks yet.' });
    }

    const me = await lookup(b.token);
    if (!me) return reply(401, { message: 'Please sign in.' });

    if (a === 'follow' || a === 'unfollow') {
      const uid = await mk.uidFromSlug(b.slug || '');
      if (!uid) return reply(404, { message: 'Filmmaker not found.' });
      if (uid === me.uid) return reply(400, { message: 'That\'s you.' });
      if (a === 'follow') {
        const mine = await ops.dbGet(`flieks_follows/${me.uid}`) || {};
        if (!mine[uid] && Object.keys(mine).length >= MAX_FOLLOWS) return reply(400, { message: 'You follow a lot of people already. Unfollow someone first.' });
        const at = Date.now();
        await ops.dbWrite(`flieks_follows/${me.uid}/${uid}`, { at });
        await ops.dbWrite(`flieks_followers/${uid}/${me.uid}`, { at });
      } else {
        await ops.dbWrite(`flieks_follows/${me.uid}/${uid}`, null);
        await ops.dbWrite(`flieks_followers/${uid}/${me.uid}`, null);
      }
      return reply(200, { ok: true, following: a === 'follow', followers: await mk.followerCount(uid) });
    }

    if (a === 'mine') {
      const follows = await ops.dbGet(`flieks_follows/${me.uid}`) || {};
      const out = [];
      for (const uid of Object.keys(follows)) {
        const m = await ops.dbGet(`flieks_makers/${uid}`);
        if (m && m.slug) out.push({ uid, slug: m.slug, name: m.name });
      }
      return reply(200, { following: out });
    }

    if (a === 'my-page' || a === 'save-page') {
      if (me.role !== 'filmmaker' && me.role !== 'admin') return reply(403, { message: 'Filmmakers only.' });
      let m = await mk.ensureMaker(me.uid);
      if (!m) return reply(400, { message: 'Add your name to your account first.' });
      if (a === 'save-page') {
        const e = mk.cleanEdits(b.page);
        if (e.name.length < 2) return reply(400, { message: 'Your name, as viewers should see it.' });
        m = { ...m, ...e, updated_at: Date.now() };
        await ops.dbWrite(`flieks_makers/${me.uid}`, m);
      }
      const films = await mk.filmsOf(me.uid);
      return reply(200, { page: { ...m, followers: await mk.followerCount(me.uid), films: films.length, url: `${ops.SITE}/by/${m.slug}` } });
    }

    if (a === 'announce') {
      if (me.role !== 'admin') return reply(403, { message: 'Admin only.' });
      if (!wl.okFilm(b.filmId)) return reply(404, { message: 'Film not found.' });
      const film = await ops.dbGet(`flieks_films/${b.filmId}`);
      if (!film || film.status !== 'soon') return reply(400, { message: 'The film is not coming soon.' });
      const n = film.filmmaker_uid ? await mk.followerCount(film.filmmaker_uid) : 0;
      if (n) await wl.startNotify(b.filmId, { kind: 'followers', event: 'soon' });
      return reply(200, { ok: true, followers: n });
    }

    return reply(400, { message: 'Unknown action.' });
  } catch (e) {
    console.error('[follow]', e);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};
