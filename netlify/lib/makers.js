/**
 * makers — filmmakers' public pages and their followers.
 *
 *   flieks_makers/{uid}          { slug, name, location, bio, instagram, website, updated_at }
 *                                (made from the filmmaker's account the first time it's needed)
 *   flieks_maker_slugs/{slug}    uid
 *   flieks_follows/{viewer}/{maker}    { at }    who a viewer follows
 *   flieks_followers/{maker}/{viewer}  { at }    a filmmaker's followers
 *   flieks_ops/follow_notified/{filmId}_{event}/{viewer}   { at, ok }
 *
 * Followers get one email when a filmmaker's new film is announced (coming soon
 * or a trailer premiere) and one when it goes live. People who already had the
 * watchlist email for that film, or already bought it, are skipped.
 */
const ops = require('./ops-core');
const wl = require('./watchlist');

const str = (v, n) => (v == null ? '' : String(v)).trim().slice(0, n);
const okUid = u => typeof u === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(u);
const slugify = s => str(s, 80).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
const cleanInstagram = v => str(v, 60).replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '').replace(/[^A-Za-z0-9._]/g, '').slice(0, 30);
const cleanWebsite = v => { const s = str(v, 200); return /^https:\/\/[^\s<>"]+\.[^\s<>"]+$/i.test(s) ? s : ''; };

/* Only people with films on the site get a page. */
async function filmsOf(uid, films) {
  const all = films || await ops.dbGet('flieks_films') || {};
  return Object.entries(all).filter(([, f]) => f && f.filmmaker_uid === uid && (f.status === 'live' || f.status === 'soon'))
    .map(([id, f]) => ({ id, ...f }));
}

/** The filmmaker's public record, created (with a unique slug) the first time. */
async function ensureMaker(uid, films) {
  if (!okUid(uid)) return null;
  const have = await ops.dbGet(`flieks_makers/${uid}`);
  if (have && have.slug) return have;
  const [user, mine] = await Promise.all([ops.dbGet(`flieks_users/${uid}`), filmsOf(uid, films)]);
  const name = str((user && (user.name || user.display_name)) || (mine[0] && mine[0].filmmaker), 80);
  if (!name) return null;
  const base = slugify(name) || 'filmmaker';
  let slug = base, n = 2;
  while (await ops.dbGet(`flieks_maker_slugs/${slug}`)) slug = `${base}-${n++}`;
  const rec = { slug, name, location: str(user && user.location, 60) || str(mine[0] && mine[0].filmmaker_location, 60) || null,
    bio: str(user && user.bio, 600) || null, instagram: null, website: null, updated_at: Date.now() };
  await ops.dbWrite(`flieks_maker_slugs/${slug}`, uid);
  await ops.dbWrite(`flieks_makers/${uid}`, rec);
  return rec;
}

async function uidFromSlug(slug) {
  const s = slugify(slug);
  return s ? await ops.dbGet(`flieks_maker_slugs/${s}`) : null;
}

async function followerCount(uid) {
  return Object.keys(await ops.dbGet(`flieks_followers/${uid}`) || {}).length;
}

/** The public page: no email, no uid-only details beyond what films already show. */
async function publicPage(uid) {
  const films = await ops.dbGet('flieks_films') || {};
  const mine = await filmsOf(uid, films);
  if (!mine.length) return null;
  const m = await ensureMaker(uid, films);
  if (!m) return null;
  return {
    uid, slug: m.slug, name: m.name, location: m.location || '', bio: m.bio || '',
    instagram: m.instagram || '', website: m.website || '',
    followers: await followerCount(uid),
    films: mine.sort((a, b) => (b.published_at || b.submitted_at || 0) - (a.published_at || a.submitted_at || 0)).map(f => f.id)
  };
}

function cleanEdits(e) {
  return {
    name: str(e && e.name, 80), location: str(e && e.location, 60) || null, bio: str(e && e.bio, 600) || null,
    instagram: cleanInstagram(e && e.instagram) || null, website: cleanWebsite(e && e.website) || null
  };
}

function followEmail(film, maker, event) {
  const title = film.title || 'A new film';
  const url = wl.filmUrl(film);
  const live = event === 'live';
  const heading = live ? `${title} is live` : film.premiere ? `${title}: an exclusive trailer is coming` : `${title} is coming soon`;
  const footer = `You follow ${maker.name} on 4flieks. To stop, open their page and tap Following.`;
  const price = film.premiere ? str(film.release_line, 120) : live ? (film.free ? 'Free to watch' : `Rent R${film.price_rent ?? 25} for 48 hours · Own R${film.price_own ?? 49}`) : '';
  return {
    subject: live ? `New from ${maker.name}: ${title} is live on 4flieks` : `New from ${maker.name}: ${title}`,
    text: [`${heading}.`, '', `A new film from ${maker.name}.`, str(film.synopsis, 320), price, '', url, '', footer].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n'),
    html: wl.shell({ kicker: `New from ${maker.name}`, heading, by: '', poster: wl.posterOf(film), url,
      body: str(film.synopsis, 320), price, cta: live ? 'Watch it now' : film.premiere ? 'Set a reminder' : 'Tell me when it\'s live', footer })
  };
}

/** Email a filmmaker's followers about one of their films ('soon' or 'live'). Safe to run again. */
async function notifyFollowers(filmId, event, { send = wl.sendBatch, pauseMs = 600 } = {}) {
  if (!wl.okFilm(filmId) || !['soon', 'live'].includes(event)) return { ok: false, reason: 'bad request' };
  const film = await ops.dbGet(`flieks_films/${filmId}`);
  if (!film || !film.filmmaker_uid) return { ok: false, reason: 'film not found' };
  if (event === 'live' && (film.status !== 'live' || film.premiere)) return { ok: false, reason: 'the film is not live' };
  if (event === 'soon' && film.status !== 'soon') return { ok: false, reason: 'the film is not coming soon' };
  film.id = filmId;
  const maker = await ensureMaker(film.filmmaker_uid);
  if (!maker) return { ok: false, reason: 'no filmmaker page' };
  const donePath = `flieks_ops/follow_notified/${filmId}_${event}`;
  const [followers, done, watchDone] = await Promise.all([
    ops.dbGet(`flieks_followers/${film.filmmaker_uid}`), ops.dbGet(donePath),
    event === 'live' ? ops.dbGet(`flieks_ops/watch_notified/${filmId}`) : null
  ]);
  const todo = []; let skipped = 0;
  for (const uid of Object.keys(followers || {})) {
    if ((done || {})[uid] || (watchDone || {})[uid]) { skipped++; continue; }
    const [user, bought] = await Promise.all([ops.dbGet(`flieks_users/${uid}`), event === 'live' ? ops.dbGet(`flieks_purchases/${uid}/${filmId}`) : null]);
    if (bought || !wl.validEmail((user && user.email) || '') || (watchDone || {})[wl.emailKey(user.email)]) { skipped++; continue; }
    todo.push({ uid, email: user.email });
  }
  const mail = followEmail(film, maker, event);
  let sent = 0, failed = 0, lastError = null;
  for (let i = 0; i < todo.length; i += 100) {
    const chunk = todo.slice(i, i + 100);
    const r = await send(chunk.map(t => ({ to: t.email, ...mail })));
    if (r.ok) {
      sent += chunk.length;
      const at = Date.now();
      await ops.dbWrite(donePath, Object.fromEntries(chunk.map(t => [t.uid, { at, ok: true }])), 'PATCH');
    } else { failed += chunk.length; lastError = r.reason; }
    if (i + 100 < todo.length && pauseMs) await new Promise(res => setTimeout(res, pauseMs));
  }
  return { ok: true, event, followers: Object.keys(followers || {}).length, sent, skipped, failed, error: lastError };
}

module.exports = { slugify, okUid, ensureMaker, uidFromSlug, publicPage, followerCount, cleanEdits, followEmail, notifyFollowers, filmsOf };
