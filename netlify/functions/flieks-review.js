/**
 * flieks-review — ratings and comments from people who actually bought the film.
 *
 * Only verified buyers can review, which is checked here rather than trusted
 * from the browser. Reviews publish immediately; a filmmaker can reply to any
 * of them, and can hide an abusive comment.
 *
 * A hidden comment's star rating still counts toward the film's average. A
 * filmmaker who could bury one-star reviews would make the whole rating
 * meaningless, and viewers notice that faster than anyone expects.
 *
 * POST { token, filmId, action, ... }
 *   post   { rating 1-5, body? }   leave or update your own review
 *   remove                          delete your own review
 *   reply  { reviewId, body }       filmmaker or admin answers publicly
 *   hide   { reviewId, reason }     filmmaker or admin hides the text
 *   unhide { reviewId }             admin only
 *   report { reviewId }             any signed-in viewer flags it
 */
const https = require('https');

const DB      = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET  = process.env.FIREBASE_DB_SECRET;
const API_KEY = process.env.FIREBASE_API_KEY;

const MAX_BODY = 900;
const REPORTS_BEFORE_HIDDEN = 3;

function req(url, opts = {}, body = null) {
  return new Promise((res, rej) => {
    const r = https.request(url, opts, x => {
      let d = ''; x.on('data', c => d += c);
      x.on('end', () => res({ status: x.statusCode, body: d }));
    });
    r.on('error', rej);
    if (body) r.write(body);
    r.end();
  });
}

const dbGet = async p => JSON.parse((await req(`${DB}/${p}.json?auth=${SECRET}`)).body || 'null');
const dbWrite = (p, data, method) => {
  const b = JSON.stringify(data);
  return req(`${DB}/${p}.json?auth=${SECRET}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);
};
const dbPut    = (p, d) => dbWrite(p, d, 'PUT');
const dbPatch  = (p, d) => dbWrite(p, d, 'PATCH');
const dbDelete = p => req(`${DB}/${p}.json?auth=${SECRET}`, { method: 'DELETE' });

async function verifyToken(token) {
  if (!API_KEY) throw new Error('FIREBASE_API_KEY is not set.');
  const b = JSON.stringify({ idToken: token });
  const r = await req(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);
  const d = JSON.parse(r.body || '{}');
  if (!d.users || !d.users[0]) throw new Error('bad token');
  return d.users[0];
}

const clean = s => String(s || '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .trim().slice(0, MAX_BODY);

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj)
});

/* Recalculates the film's average from every review, hidden ones included. */
async function recount(filmId) {
  const all = await dbGet(`flieks_reviews/${filmId}`) || {};
  const ratings = Object.values(all).map(r => Number(r.rating)).filter(n => n >= 1 && n <= 5);
  const count = ratings.length;
  const avg = count ? +(ratings.reduce((a, b) => a + b, 0) / count).toFixed(2) : 0;
  await dbPatch(`flieks_films/${filmId}`, { rating_avg: avg, rating_count: count });
  return { avg, count };
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  try {
    const p = JSON.parse(event.body || '{}');
    const { token, filmId, action } = p;
    if (!token || !filmId || !action) return reply(400, { message: 'Missing details.' });

    const user = await verifyToken(token);
    const uid = user.localId;

    const [profile, film] = await Promise.all([
      dbGet(`flieks_users/${uid}`),
      dbGet(`flieks_films/${filmId}`)
    ]);
    if (!film) return reply(404, { message: 'No such film.' });

    const isAdmin = profile && profile.role === 'admin';
    const isMaker = film.filmmaker_uid === uid;

    /* ---- leave or update a review ---- */
    if (action === 'post') {
      const rating = Number(p.rating);
      if (!(rating >= 1 && rating <= 5)) return reply(400, { message: 'Pick a rating from 1 to 5.' });

      // Only people who paid. Checked here, not trusted from the browser.
      const bought = await dbGet(`flieks_purchases/${uid}/${filmId}`);
      if (!bought) {
        return reply(403, { message: 'Only people who have bought the film can review it.' });
      }

      const existing = await dbGet(`flieks_reviews/${filmId}/${uid}`) || {};
      const body = clean(p.body);

      await dbPut(`flieks_reviews/${filmId}/${uid}`, {
        uid,
        name: (profile && profile.name) || user.displayName || 'A viewer',
        rating,
        body,
        // Editing your own words shouldn't quietly un-hide them.
        hidden: existing.hidden || false,
        hidden_reason: existing.hidden_reason || null,
        reply: existing.reply || null,
        reports: existing.reports || null,
        bought_type: bought.type || null,
        created_at: existing.created_at || Date.now(),
        updated_at: Date.now()
      });

      const totals = await recount(filmId);
      return reply(200, { ok: true, ...totals });
    }

    /* ---- withdraw your own ---- */
    if (action === 'remove') {
      const mine = await dbGet(`flieks_reviews/${filmId}/${uid}`);
      if (!mine) return reply(404, { message: 'You have not reviewed this film.' });
      await dbDelete(`flieks_reviews/${filmId}/${uid}`);
      const totals = await recount(filmId);
      return reply(200, { ok: true, ...totals });
    }

    const reviewId = p.reviewId;
    if (!reviewId) return reply(400, { message: 'Which review?' });
    const target = await dbGet(`flieks_reviews/${filmId}/${reviewId}`);
    if (!target) return reply(404, { message: 'No such review.' });

    /* ---- the filmmaker answers publicly ---- */
    if (action === 'reply') {
      if (!isMaker && !isAdmin) return reply(403, { message: 'Not your film.' });
      const body = clean(p.body);
      if (!body) return reply(400, { message: 'Write something first.' });
      await dbPatch(`flieks_reviews/${filmId}/${reviewId}`, {
        reply: {
          body,
          by: (profile && profile.name) || film.filmmaker || 'The filmmaker',
          at: Date.now()
        }
      });
      return reply(200, { ok: true });
    }

    /* ---- hide an abusive comment ----
       The text goes; the rating stays in the average. A filmmaker cannot
       improve their score this way, only remove language that shouldn't
       be on the page. */
    if (action === 'hide') {
      if (!isMaker && !isAdmin) return reply(403, { message: 'Not your film.' });
      await dbPatch(`flieks_reviews/${filmId}/${reviewId}`, {
        hidden: true,
        hidden_reason: clean(p.reason).slice(0, 140) || 'Hidden by the filmmaker',
        hidden_by: isAdmin ? 'admin' : 'filmmaker',
        hidden_at: Date.now()
      });
      // Logged so hiding is reviewable rather than silent.
      await dbPut(`flieks_moderation/${filmId}_${reviewId}`, {
        filmId, reviewId,
        filmTitle: film.title || '',
        by: isAdmin ? 'admin' : 'filmmaker',
        byUid: uid,
        reason: clean(p.reason).slice(0, 140),
        rating: target.rating,
        body: target.body || '',
        at: Date.now()
      });
      return reply(200, { ok: true, note: 'Comment hidden. The rating still counts.' });
    }

    /* ---- admin can put it back ---- */
    if (action === 'unhide') {
      if (!isAdmin) return reply(403, { message: 'Admin only.' });
      await dbPatch(`flieks_reviews/${filmId}/${reviewId}`, {
        hidden: false, hidden_reason: null, hidden_by: null
      });
      await dbDelete(`flieks_moderation/${filmId}_${reviewId}`);
      return reply(200, { ok: true });
    }

    /* ---- a viewer flags something ---- */
    if (action === 'report') {
      if (reviewId === uid) return reply(400, { message: 'That is your own review.' });
      const reports = { ...(target.reports || {}), [uid]: Date.now() };
      const n = Object.keys(reports).length;
      const patch = { reports };

      if (n >= REPORTS_BEFORE_HIDDEN && !target.hidden) {
        patch.hidden = true;
        patch.hidden_reason = 'Hidden pending review';
        patch.hidden_by = 'reports';
        await dbPut(`flieks_moderation/${filmId}_${reviewId}`, {
          filmId, reviewId, filmTitle: film.title || '',
          by: 'reports', reports: n,
          rating: target.rating, body: target.body || '', at: Date.now()
        });
      }
      await dbPatch(`flieks_reviews/${filmId}/${reviewId}`, patch);
      return reply(200, { ok: true, reports: n });
    }

    return reply(400, { message: 'Unknown action.' });

  } catch (e) {
    console.error('review error:', e);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};
