/**
 * flieks-moderate — the admin's full view of 4flieks, price rules, and quick fixes.
 *
 * Anyone:
 *   settings                          the price norm and ceiling (the filmmaker forms show them)
 * Filmmaker:
 *   request-price { filmId, rent, own }   a price above the ceiling waits for the team to approve it
 * Admin:
 *   everything                        every film (any status), filmmaker page, talent profile (incl. private),
 *                                     podcast channel, list and recent review, with what changed since last check
 *   mark-checked                      "I've looked at everything up to now"
 *   settings-save { rent, own }       the price ceiling (0 = none)
 *   set-price { filmId, rent, own, free? }
 *   decide-price { filmId, approve }  approve or decline a filmmaker's price request
 *   hide { kind: 'maker'|'talent', uid, hidden }
 *
 *   flieks_settings/price_cap  { rent, own }
 *   flieks_films/{id}/price_request  { rent, own, at }
 *   flieks_ops/moderation_seen  timestamp
 */
const ops = require('../lib/ops-core');

const NORM = { rent: 25, own: 49 };
const reply = (code, obj, cache) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': cache ? 'public, max-age=60' : 'no-store' }, body: JSON.stringify(obj) });
const okId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const str = (v, n) => (v == null ? '' : String(v)).trim().slice(0, n);
const money = v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && n <= 5000 ? n : null; };
const TEAM = () => process.env.OPS_EMAIL_TO || process.env.SUPPORT_EMAIL;

async function lookup(token) {
  const key = process.env.FIREBASE_API_KEY;
  if (!token || !key) return null;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token })
  });
  const u = ((await r.json().catch(() => ({}))).users || [])[0];
  if (!u) return null;
  const profile = await ops.dbGet(`flieks_users/${u.localId}`) || {};
  return { uid: u.localId, email: u.email || '', role: profile.role || 'viewer', name: profile.name || '' };
}

async function priceCap() {
  const c = await ops.dbGet('flieks_settings/price_cap');
  return c && (c.rent > 0 || c.own > 0) ? { rent: c.rent || null, own: c.own || null } : null;
}
const overCap = (cap, rent, own) => !!cap && ((cap.rent && rent > cap.rent) || (cap.own && own > cap.own));

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { message: 'Bad request.' }); }
  const a = b.action;
  try {
    if (a === 'settings') return reply(200, { norm: NORM, cap: await priceCap() }, true);

    const me = await lookup(b.token);
    if (!me) return reply(401, { message: 'Please sign in.' });

    if (a === 'request-price') {
      if (!okId(b.filmId)) return reply(404, { message: 'Film not found.' });
      const film = await ops.dbGet(`flieks_films/${b.filmId}`);
      if (!film || (film.filmmaker_uid !== me.uid && me.role !== 'admin')) return reply(404, { message: 'Film not found.' });
      const rent = money(b.rent), own = money(b.own);
      if (rent == null || own == null) return reply(400, { message: 'Those prices don\'t look right.' });
      await ops.dbWrite(`flieks_films/${b.filmId}/price_request`, { rent, own, at: Date.now() });
      if (TEAM()) await ops.sendEmailTo({ to: TEAM(), replyTo: me.email, subject: `Price request: ${film.title} (R${rent} / R${own})`,
        text: `${me.name || me.email} wants to charge R${rent} to rent and R${own} to own "${film.title}" (above the ceiling). Approve or decline in admin → Everything: ${ops.SITE}/admin#everything` }).catch(() => {});
      return reply(200, { ok: true });
    }

    if (me.role !== 'admin') return reply(403, { message: 'Admin only.' });

    if (a === 'everything') {
      const [films, makers, talent, channels, episodes, lists, reviews, seen, users, cap] = await Promise.all([
        ops.dbGet('flieks_films'), ops.dbGet('flieks_makers'), ops.dbGet('flieks_talent'), ops.dbGet('flieks_pod_channels'),
        ops.dbGet('flieks_pod_episodes'), ops.dbGet('flieks_lists'), ops.dbGet('flieks_reviews'), ops.dbGet('flieks_ops/moderation_seen'),
        ops.dbGet('flieks_users'), priceCap()]);
      const F = films || {};
      const eps = Object.values(episodes || {});
      const out = {
        seen: seen || 0, cap, norm: NORM,
        films: Object.entries(F).map(([id, f]) => ({ id, title: f.title || id, filmmaker: f.filmmaker || '', filmmaker_uid: f.filmmaker_uid || null,
          status: f.status || '', poster_url: f.poster_url || null, synopsis: str(f.synopsis, 400), about: str(f.about, 400),
          price_rent: f.price_rent || 0, price_own: f.price_own || 0, free: !!f.free, price_request: f.price_request || null,
          over_cap: !f.free && overCap(cap, f.price_rent || 0, f.price_own || 0), slug: f.slug || id,
          changed_at: Math.max(f.updated_at || 0, f.submitted_at || 0, f.published_at || 0) })),
        makers: Object.entries(makers || {}).map(([uid, m]) => ({ uid, slug: m.slug, name: m.name, location: m.location || '', bio: m.bio || '',
          instagram: m.instagram || '', website: m.website || '', hidden: !!m.hidden, changed_at: m.updated_at || 0 })),
        talent: Object.entries(talent || {}).map(([uid, t]) => ({ uid, name: t.name || '', bio: str(t.bio, 400), disciplines: t.disciplines || [],
          photo_url: t.photo_url || null, suggest: t.suggest === true, hidden: !!t.hidden_by_admin, city: t.city || '', country: t.country || '',
          changed_at: t.updated_at || t.created_at || 0 })),
        podcasts: Object.entries(channels || {}).map(([id, c]) => ({ id, slug: c.slug, title: c.title, host: c.host || '', description: str(c.description, 400),
          status: c.status, episodes: eps.filter(e => e && e.channel_id === id).length, paid: eps.filter(e => e && e.channel_id === id && e.price > 0).length,
          changed_at: c.updated_at || c.created_at || 0 })),
        lists: Object.entries(lists || {}).map(([id, l]) => ({ id, slug: l.slug, title: l.title, published: !!l.published, films: (l.films || []).length, changed_at: l.updated_at || 0 })),
        reviews: Object.entries(reviews || {}).flatMap(([filmId, byUid]) => Object.entries(byUid || {}).map(([rid, r]) => ({
          filmId, reviewId: rid, film: (F[filmId] || {}).title || filmId, name: r.name || '', rating: r.rating, body: str(r.body, 400),
          hidden: !!r.hidden, reports: Object.keys(r.reports || {}).length, changed_at: r.updated_at || r.created_at || 0 })))
          .sort((x, y) => y.changed_at - x.changed_at).slice(0, 60)
      };
      const U = users || {};
      out.films.forEach(f => { const u = U[f.filmmaker_uid] || {}; f.filmmaker_email = u.email || ''; });
      return reply(200, out);
    }

    if (a === 'mark-checked') { const at = Date.now(); await ops.dbWrite('flieks_ops/moderation_seen', at); return reply(200, { ok: true, seen: at }); }

    if (a === 'settings-save') {
      const rent = money(b.rent) || 0, own = money(b.own) || 0;
      await ops.dbWrite('flieks_settings/price_cap', rent || own ? { rent: rent || null, own: own || null } : null);
      return reply(200, { ok: true, cap: rent || own ? { rent: rent || null, own: own || null } : null });
    }

    if (a === 'set-price' || a === 'decide-price') {
      if (!okId(b.filmId)) return reply(404, { message: 'Film not found.' });
      const film = await ops.dbGet(`flieks_films/${b.filmId}`);
      if (!film) return reply(404, { message: 'Film not found.' });
      let rent, own, free = !!film.free;
      if (a === 'set-price') {
        free = !!b.free; rent = free ? 0 : money(b.rent); own = free ? 0 : money(b.own);
        if (!free && (!(rent > 0) || !(own > 0))) return reply(400, { message: 'Set both prices, or make it free.' });
        if (!free && own < rent) return reply(400, { message: 'The own price should be at least the rent price.' });
      } else {
        const req = film.price_request;
        if (!req) return reply(400, { message: 'There is no price request on this film.' });
        if (b.approve) { rent = req.rent; own = req.own; } else { rent = film.price_rent; own = film.price_own; }
      }
      await ops.dbWrite(`flieks_films/${b.filmId}`, { price_rent: rent, price_own: own, free, price_request: null, updated_at: Date.now() }, 'PATCH');
      if (a === 'decide-price' && film.filmmaker_uid) {
        const u = await ops.dbGet(`flieks_users/${film.filmmaker_uid}`);
        if (u && u.email) await ops.sendEmailTo({ to: u.email, replyTo: TEAM(), subject: `Your price for ${film.title}: ${b.approve ? 'approved' : 'not approved'}`,
          text: b.approve ? `Hi ${(u.name || '').split(' ')[0] || 'there'},\n\n"${film.title}" is now R${rent} to rent and R${own} to own.\n\nThe 4flieks team`
            : `Hi ${(u.name || '').split(' ')[0] || 'there'},\n\nWe've kept "${film.title}" at R${rent} to rent and R${own} to own. Films priced near R25 / R49 sell far more tickets. Reply to this email if you'd like to talk it through.\n\nThe 4flieks team` }).catch(() => {});
      }
      return reply(200, { ok: true, price_rent: rent, price_own: own, free });
    }

    if (a === 'hide') {
      if (!okId(b.uid)) return reply(400, { message: 'Which profile?' });
      if (b.kind === 'maker') await ops.dbWrite(`flieks_makers/${b.uid}/hidden`, b.hidden ? true : null);
      else if (b.kind === 'talent') await ops.dbWrite(`flieks_talent/${b.uid}/hidden_by_admin`, b.hidden ? true : null);
      else return reply(400, { message: 'Unknown kind.' });
      return reply(200, { ok: true });
    }

    return reply(400, { message: 'Unknown action.' });
  } catch (e) {
    console.error('[moderate]', a, e);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};
