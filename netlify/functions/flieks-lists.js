/**
 * flieks-lists — lists of films ("Taxi stories", "isiZulu shorts", "Made in Durban").
 *
 * Curated by 4flieks for now; the shape leaves room for viewer and filmmaker
 * lists later (owner, curated:false).
 *
 *   flieks_lists/{id}  { title, slug, description, films: [filmId…], published,
 *                        on_home, order, curated: true, owner, created_at, updated_at }
 *
 * GET  ?slug=x                   one published list (for link previews)
 * POST { action: 'public' }      every published list, for the site (no sign-in)
 * POST { action: 'all',    token }            admin: every list, drafts too
 * POST { action: 'save',   token, list }      admin: create or update
 * POST { action: 'delete', token, id }        admin
 */
const crypto = require('crypto');
const ops = require('../lib/ops-core');

const reply = (code, obj, cache) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': cache ? 'public, max-age=60' : 'no-store' },
  body: JSON.stringify(obj)
});

const str = (v, n) => (v == null ? '' : String(v)).trim().slice(0, n);
const okId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(id);
const slugify = s => str(s, 80).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const MAX_FILMS = 60;

/* What the site sees: no owner uid, only films that are on the site. */
function publicList(id, l, films) {
  const visible = (l.films || []).filter(f => films[f] && (films[f].status === 'live' || films[f].status === 'soon'));
  return { id, slug: l.slug, title: l.title, description: l.description || '', films: visible,
    on_home: !!l.on_home, order: Number(l.order) || 0, curated: l.curated !== false, updated_at: l.updated_at || 0 };
}

async function publishedLists() {
  const [lists, films] = await Promise.all([ops.dbGet('flieks_lists'), ops.dbGet('flieks_films')]);
  return Object.entries(lists || {})
    .filter(([, l]) => l && l.published)
    .map(([id, l]) => publicList(id, l, films || {}))
    .filter(l => l.films.length)
    .sort((a, b) => a.order - b.order || b.updated_at - a.updated_at);
}

exports.handler = async event => {
  try {
    if (event.httpMethod === 'GET') {
      const slug = slugify((event.queryStringParameters || {}).slug || '');
      const list = (await publishedLists()).find(l => l.slug === slug);
      return list ? reply(200, { list }, true) : reply(404, { message: 'List not found.' }, true);
    }
    if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
    let b;
    try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { message: 'Bad request.' }); }

    if (b.action === 'public') return reply(200, { lists: await publishedLists() }, true);

    const admin = await ops.verifyAdmin(b.token);
    if (!admin) return reply(403, { message: 'Admin only.' });

    if (b.action === 'all') {
      const lists = await ops.dbGet('flieks_lists') || {};
      return reply(200, { lists: Object.entries(lists).map(([id, l]) => ({ id, ...l }))
        .sort((a, c) => (Number(a.order) || 0) - (Number(c.order) || 0) || (c.updated_at || 0) - (a.updated_at || 0)) });
    }

    if (b.action === 'save') {
      const L = b.list || {};
      const title = str(L.title, 80);
      if (title.length < 2) return reply(400, { message: 'Give the list a title.' });
      const id = L.id ? String(L.id) : crypto.randomBytes(6).toString('hex');
      if (!okId(id)) return reply(400, { message: 'Bad list.' });
      const [all, films] = await Promise.all([ops.dbGet('flieks_lists'), ops.dbGet('flieks_films')]);
      const prev = (all || {})[id];
      if (L.id && !prev) return reply(404, { message: 'That list no longer exists.' });
      const filmIds = [...new Set((Array.isArray(L.films) ? L.films : []).filter(okId))].filter(f => (films || {})[f]).slice(0, MAX_FILMS);
      // A readable, unique address: /list/taxi-stories
      let base = slugify(L.slug || title) || 'list', slug = base, n = 2;
      const taken = new Set(Object.entries(all || {}).filter(([k]) => k !== id).map(([, l]) => l && l.slug));
      while (taken.has(slug)) slug = `${base}-${n++}`;
      const now = Date.now();
      const rec = {
        title, slug, description: str(L.description, 400) || null, films: filmIds,
        published: !!L.published, on_home: !!L.on_home, order: Math.max(0, Math.min(999, parseInt(L.order, 10) || 0)),
        curated: true, owner: (prev && prev.owner) || admin.localId,
        created_at: (prev && prev.created_at) || now, updated_at: now
      };
      await ops.dbWrite(`flieks_lists/${id}`, rec);
      return reply(200, { ok: true, list: { id, ...rec } });
    }

    if (b.action === 'delete') {
      if (!okId(b.id)) return reply(404, { message: 'List not found.' });
      await ops.dbWrite(`flieks_lists/${b.id}`, null);
      return reply(200, { ok: true });
    }

    return reply(400, { message: 'Unknown action.' });
  } catch (e) {
    console.error('[lists]', e);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};

exports.slugify = slugify;
