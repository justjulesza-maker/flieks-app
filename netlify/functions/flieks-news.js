/**
 * flieks-news — industry headlines for the Lab (front page and opportunities board).
 *
 * Anyone:
 *   list { limit?, tag?, token? }   newest first, with updated (when the feeds were last read); tag: funding | call | news | opps (funding + calls); a team member's token also returns admin: true
 * Admin (role 'admin'):
 *   hide    { id }                  take a story off the Lab; refreshes never bring it back
 *   add     { title, link, tag? }   add a story by hand (any https link)
 *   refresh                         read the feeds now (10 an hour)
 *   status                          when the feeds were last read and how each one did
 *
 * The page never touches the database. See netlify/lib/news-core.js.
 */
const ops = require('../lib/ops-core');
const news = require('../lib/news-core');

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  body: JSON.stringify(obj)
});
const hour = () => new Date().toISOString().slice(0, 13).replace(/[-:T]/g, '');
const slot = (path, limit) => ops.takeSlot(path, limit).catch(() => false);   // fails closed (audit L8)
const str = (v, n) => typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '';

/* A short cache in this instance, so a busy Lab page is not a database read per visit. */
let CACHE = null;
const CACHE_MS = 5 * 60e3;
async function allItems() {
  if (CACHE && Date.now() - CACHE.at < CACHE_MS) return CACHE;
  const [raw0, meta] = await Promise.all([ops.dbGet('flieks_news/items'), ops.dbGet('flieks_news/meta')]);
  const raw = raw0 || {};
  const items = Object.entries(raw).filter(([id]) => news.ID.test(id)).map(([id, it]) => news.publicItem(id, it)).filter(Boolean)
    .sort((a, b) => b.at - a.at);
  CACHE = { at: Date.now(), items, updated: Number(meta && meta.at) || 0 };
  return CACHE;
}

async function isAdmin(token) {
  const key = process.env.FIREBASE_API_KEY;
  if (!token || typeof token !== 'string' || token.length > 4096 || !key) return false;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token })
  });
  const u = ((await r.json().catch(() => ({}))).users || [])[0];
  if (!u || typeof u.localId !== 'string' || !/^[A-Za-z0-9]{10,128}$/.test(u.localId)) return false;
  const profile = await ops.dbGet(`flieks_users/${u.localId}`) || {};
  return profile.role === 'admin';
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { message: 'Bad request.' }); }
  if (!b || typeof b !== 'object') return reply(400, { message: 'Bad request.' });
  const a = b.action;

  try {
    if (a === 'list') {
      const limit = Math.max(1, Math.min(40, parseInt(b.limit, 10) || 12));
      const tag = news.TAGS.concat('opps').includes(b.tag) ? b.tag : '';   // opps = funding and open calls
      const admin = b.token ? await isAdmin(b.token).catch(() => false) : false;
      const { items: all, updated } = await allItems();
      const items = (tag ? all.filter(it => tag === 'opps' ? it.tag !== 'news' : it.tag === tag) : all).slice(0, limit);
      return reply(200, { items, admin, updated });
    }

    if (!['hide', 'add', 'refresh', 'status'].includes(a)) return reply(400, { message: 'Unknown action.' });
    if (!(await isAdmin(b.token).catch(() => false))) return reply(403, { message: 'Team only.' });

    if (a === 'hide') {
      if (typeof b.id !== 'string' || !news.ID.test(b.id)) return reply(404, { message: 'Not found.' });
      await ops.dbWrite(`flieks_news/hidden/${b.id}`, true);
      await ops.dbWrite(`flieks_news/items/${b.id}`, null);
      CACHE = null;
      return reply(200, { ok: true });
    }

    if (a === 'add') {
      const title = news.tidyTitle(str(b.title, 220));
      const link = news.safeLink(str(b.link, 500), null);
      if (title.length < 6) return reply(400, { message: 'Give the story a headline.' });
      if (!link) return reply(400, { message: 'The link must be a full https:// address.' });
      if (news.blocked(title, link)) return reply(400, { message: 'That story can’t go on 4flieks.' });
      const id = news.idFor(link);
      const tag = news.TAGS.includes(b.tag) ? b.tag : news.tagFor(title);
      await ops.dbWrite(`flieks_news/hidden/${id}`, null);
      await ops.dbWrite(`flieks_news/items/${id}`, { id, title, link, source: 'team', at: Date.now(), tag, manual: true });
      CACHE = null;
      return reply(200, { ok: true, id });
    }

    if (a === 'refresh') {
      if (!(await slot(`flieks_ops/news_rate/${hour()}`, 10))) return reply(429, { message: 'Read the feeds a lot this hour already. Try again later.' });
      const { items, meta } = await news.refresh(ops, { by: 'team' });
      CACHE = null;
      return reply(200, { ok: true, count: Object.keys(items).length, meta, names: Object.fromEntries(news.SOURCES.map(x => [x.id, x.name])) });
    }

    if (a === 'status') {
      const [meta, hidden] = await Promise.all([ops.dbGet('flieks_news/meta'), ops.dbGet('flieks_news/hidden')]);
      return reply(200, { meta: meta || null, hidden: Object.keys(hidden || {}).length,
        sources: news.SOURCES.map(s => ({ id: s.id, name: s.name, feed: s.feed })) });
    }
  } catch (e) {
    console.error('[news]', a, e.message);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};
