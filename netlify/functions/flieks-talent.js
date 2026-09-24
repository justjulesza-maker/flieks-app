/**
 * flieks-talent — the talent directory (4flieks.biz starts here).
 *
 * POST { action, token, ... }
 *   me                             my profile, credits and pending claims
 *   save      { profile }          create/update my profile (suggest: true = opt in)
 *   delete-profile                 remove my profile and unlink my credits
 *   claim     { filmId, castKey }  "I'm this person in that film" (filmmaker approves)
 *   withdraw  { filmId, castKey }  take back a pending claim
 *   remove-credit { filmId, castKey }  take an approved credit off my profile
 *   claims                         filmmaker: pending claims on my films
 *   approve / decline { filmId, castKey, uid }   filmmaker (or admin) decides
 */
const ops = require('../lib/ops-core');
const { cleanProfile, record } = require('../lib/talent');

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});
const okKey = k => typeof k === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(k);

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

async function filmOwnedBy(filmId, me) {
  const film = await ops.dbGet(`flieks_films/${filmId}`);
  if (!film) return null;
  return (film.filmmaker_uid === me.uid || me.role === 'admin') ? film : null;
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { message: 'Bad request.' }); }
  try {
    const me = await lookup(b.token);
    if (!me) return reply(401, { message: 'Please sign in.' });
    const a = b.action;

    if (a === 'me') {
      const p = await ops.dbGet(`flieks_talent/${me.uid}`);
      const claims = await ops.dbGet('flieks_talent_claims') || {};
      const pending = [];
      for (const [filmId, byCast] of Object.entries(claims)) {
        for (const [castKey, byUid] of Object.entries(byCast || {})) {
          if (byUid && byUid[me.uid]) pending.push({ filmId, castKey, ...byUid[me.uid] });
        }
      }
      return reply(200, {
        profile: p ? { ...p, email: undefined } : null,
        record: p ? await record(p) : null,
        pending, account: { email: me.email, name: me.name }
      });
    }

    if (a === 'save') {
      const clean = cleanProfile(b.profile);
      if (clean.name.length < 2) return reply(400, { message: 'Add your name as you want filmmakers to see it.' });
      if (!clean.disciplines.length) return reply(400, { message: 'Pick at least one thing you do.' });
      const prev = await ops.dbGet(`flieks_talent/${me.uid}`) || {};
      const now = Date.now();
      await ops.dbWrite(`flieks_talent/${me.uid}`, {
        ...prev, ...clean, email: me.email,
        suggest_at: clean.suggest ? (prev.suggest ? prev.suggest_at || now : now) : null,
        created_at: prev.created_at || now, updated_at: now
      });
      return reply(200, { ok: true });
    }

    if (a === 'delete-profile') {
      const p = await ops.dbGet(`flieks_talent/${me.uid}`);
      for (const c of Object.values((p && p.credits) || {})) {
        await ops.dbWrite(`flieks_cast/${c.film_id}/${c.cast_key}/talent_uid`, null);
      }
      await ops.dbWrite(`flieks_talent/${me.uid}`, null);
      return reply(200, { ok: true });
    }

    if (a === 'claim' || a === 'withdraw' || a === 'remove-credit') {
      if (!okKey(b.filmId) || !okKey(b.castKey)) return reply(400, { message: 'Pick the film and your name in its cast.' });
      if (a === 'withdraw') {
        await ops.dbWrite(`flieks_talent_claims/${b.filmId}/${b.castKey}/${me.uid}`, null);
        return reply(200, { ok: true });
      }
      if (a === 'remove-credit') {
        const cast = await ops.dbGet(`flieks_cast/${b.filmId}/${b.castKey}`);
        if (cast && cast.talent_uid === me.uid) await ops.dbWrite(`flieks_cast/${b.filmId}/${b.castKey}/talent_uid`, null);
        await ops.dbWrite(`flieks_talent/${me.uid}/credits/${b.filmId}__${b.castKey}`, null);
        return reply(200, { ok: true });
      }
      const profile = await ops.dbGet(`flieks_talent/${me.uid}`);
      if (!profile) return reply(409, { message: 'Create your profile first.' });
      const [film, cast] = await Promise.all([ops.dbGet(`flieks_films/${b.filmId}`), ops.dbGet(`flieks_cast/${b.filmId}/${b.castKey}`)]);
      if (!film || !cast) return reply(404, { message: 'That cast credit was not found.' });
      if (cast.talent_uid === me.uid) return reply(409, { message: 'That credit is already on your profile.' });
      if (cast.talent_uid) return reply(409, { message: 'Someone has already claimed that credit. Ask the filmmaker if it is yours.' });
      await ops.dbWrite(`flieks_talent_claims/${b.filmId}/${b.castKey}/${me.uid}`, {
        name: profile.name, at: Date.now(), film_title: film.title || '', cast_name: cast.name || '', role: cast.role || ''
      });
      // Let the filmmaker know there is something to approve.
      const owner = film.filmmaker_uid ? await ops.dbGet(`flieks_users/${film.filmmaker_uid}`) : null;
      const to = (owner && owner.email) || film.filmmaker_email;
      if (to) {
        await ops.sendEmailTo({
          to, replyTo: process.env.SUPPORT_EMAIL || 'support@4flieks.com',
          subject: `${profile.name} says they are ${cast.name || 'in your cast'} in ${film.title}`,
          text: `${profile.name} has claimed the credit "${cast.name}${cast.role ? ' (' + cast.role + ')' : ''}" on ${film.title} for their 4flieks talent profile.\n\n` +
            `If that's right, approve it in your portal so their profile shows the film and the people their link brought in:\n` +
            `${ops.SITE}/filmmaker?film=${encodeURIComponent(b.filmId)}\n\nIf it isn't them, decline it there.\n\n4flieks`
        }).catch(() => {});
      }
      return reply(200, { ok: true });
    }

    if (a === 'claims') {
      const claims = await ops.dbGet('flieks_talent_claims') || {};
      const out = [];
      for (const [filmId, byCast] of Object.entries(claims)) {
        const film = await filmOwnedBy(filmId, me);
        if (!film) continue;
        for (const [castKey, byUid] of Object.entries(byCast || {})) {
          for (const [uid, c] of Object.entries(byUid || {})) {
            const p = await ops.dbGet(`flieks_talent/${uid}`) || {};
            out.push({ filmId, castKey, uid, film_title: film.title, cast_name: c.cast_name, role: c.role, at: c.at,
              name: p.name || c.name, photo_url: p.photo_url || '', city: p.city || '', showreel: p.showreel || '' });
          }
        }
      }
      out.sort((x, y) => (y.at || 0) - (x.at || 0));
      return reply(200, { claims: out });
    }

    if (a === 'approve' || a === 'decline') {
      if (!okKey(b.filmId) || !okKey(b.castKey) || !okKey(b.uid)) return reply(400, { message: 'Bad request.' });
      const film = await filmOwnedBy(b.filmId, me);
      if (!film) return reply(403, { message: 'Only the film’s filmmaker can do that.' });
      const claim = await ops.dbGet(`flieks_talent_claims/${b.filmId}/${b.castKey}/${b.uid}`);
      if (!claim) return reply(404, { message: 'That claim is no longer pending.' });
      if (a === 'decline') {
        await ops.dbWrite(`flieks_talent_claims/${b.filmId}/${b.castKey}/${b.uid}`, null);
        return reply(200, { ok: true });
      }
      const cast = await ops.dbGet(`flieks_cast/${b.filmId}/${b.castKey}`);
      if (!cast) return reply(404, { message: 'That cast entry is gone.' });
      await ops.dbWrite(`flieks_cast/${b.filmId}/${b.castKey}/talent_uid`, b.uid);
      await ops.dbWrite(`flieks_talent/${b.uid}/credits/${b.filmId}__${b.castKey}`, {
        film_id: b.filmId, cast_key: b.castKey, film_title: film.title || '', film_slug: film.slug || b.filmId,
        role: cast.role || '', cast_name: cast.name || '', approved_at: Date.now()
      });
      // One person per credit: any other claims on it are settled.
      await ops.dbWrite(`flieks_talent_claims/${b.filmId}/${b.castKey}`, null);
      return reply(200, { ok: true });
    }

    return reply(400, { message: 'Unknown action.' });
  } catch (e) {
    console.error('[talent]', e);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};
