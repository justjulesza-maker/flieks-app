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
 *   search    { q, discipline, country, language, age }   Lab members: people who opted in (and Actors Spaces, when connected)
 *   profile   { id }                one person's profile page (opted-in people; you always see your own)
 *   contact   { id, message }       email someone who opted in; replies go to you; their email is never shown
 */
const ops = require('../lib/ops-core');
const { cleanProfile, record, card, matchCards, DISCIPLINES } = require('../lib/talent');
const actorsSpaces = require('../lib/actors-spaces');
const CONTACT_PER_DAY = parseInt(process.env.TALENT_CONNECT_PER_DAY || '20', 10);

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
  const role = profile.role || 'viewer';
  const unlimited = role === 'admin' || !!(await ops.dbGet(`flieks_lab_unlimited/${u.localId}`).catch(() => null));
  return { uid: u.localId, email: u.email || '', role, name: profile.name || '', verified: !!u.emailVerified, unlimited };
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
      if (clean.suggest && !prev.suggest) await ops.logLabEvent('opt_in', me.uid);
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
      await ops.logLabEvent('claim', me.uid, { title: film.title || '' });
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

    /* ---- the talent search (4flieks Lab) ---- */
    const canBrowse = me.role === 'filmmaker' || me.role === 'admin' || me.verified || me.unlimited;
    if (a === 'search' || a === 'profile' || a === 'contact') {
      if (!canBrowse) return reply(403, { code: 'verify', message: 'Confirm your email first: open the link we sent you, then try again.' });
    }

    if (a === 'search') {
      const f = {
        q: String(b.q || '').slice(0, 80), discipline: DISCIPLINES.includes(b.discipline) ? b.discipline : '',
        country: String(b.country || '').slice(0, 60), language: String(b.language || '').slice(0, 30), age: b.age
      };
      const all = await ops.dbGet('flieks_talent') || {};
      const ours = [];
      for (const [uid, p] of Object.entries(all)) {
        if (!p || p.suggest !== true || !p.name || p.hidden_by_admin) continue;   // only people who opted in (and not hidden by the team)
        ours.push(card(uid, p, { films: Object.values(p.credits || {}).map(c => ({ title: c.film_title, role: c.role || '' })), clicks: 0, trailer: 0, sales: 0 }));
      }
      const theirs = await actorsSpaces.search(f);
      const results = matchCards([...ours, ...theirs], f).slice(0, 60);
      return reply(200, { results, total: results.length, sources: { flieks: ours.length, actorsSpaces: actorsSpaces.enabled() } });
    }

    if (a === 'profile') {
      const id = String(b.id || '');
      if (id.startsWith('as:')) {
        const c = await actorsSpaces.profile(id);
        return c ? reply(200, { profile: c }) : reply(404, { message: 'That profile is not available.' });
      }
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return reply(404, { message: 'Profile not found.' });
      const p = await ops.dbGet(`flieks_talent/${id}`);
      const mine = id === me.uid;
      if (!p || ((!p.suggest || p.hidden_by_admin) && !mine && me.role !== 'admin')) return reply(404, { message: 'This profile is private or no longer exists.' });
      const contacted = mine ? null : await ops.dbGet(`flieks_ops/talent_contacted/${me.uid}/${id}`).catch(() => null);
      return reply(200, { profile: card(id, p, await record(p)), mine, hidden: !p.suggest, contacted_at: contacted || null });
    }

    if (a === 'contact') {
      const id = String(b.id || '');
      if (id.startsWith('as:')) return reply(400, { message: 'Contact this person through their Actors Spaces profile.' });
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || id === me.uid) return reply(400, { message: 'Bad request.' });
      const t = await ops.dbGet(`flieks_talent/${id}`);
      if (!t || t.suggest !== true || t.hidden_by_admin || !t.email) return reply(410, { message: 'They are not taking messages through 4flieks.' });
      const message = String(b.message || '').trim().slice(0, 1200);
      if (message.length < 20) return reply(400, { message: 'Say a little about the project and what you are asking (a sentence or two).' });
      const last = await ops.dbGet(`flieks_ops/talent_contacted/${me.uid}/${id}`);
      if (last && Date.now() - last < 7 * 864e5 && !me.unlimited) return reply(409, { message: 'You wrote to them this week. Give them time to reply.' });
      const day = new Date().toISOString().slice(0, 10);
      const countPath = `flieks_ops/talent_connect/${me.uid}/${day}`;
      // Counted before sending, so messages sent at the same moment can't pass the daily limit.
      if (!me.unlimited && !(await ops.takeSlot(countPath, CONTACT_PER_DAY))) return reply(429, { message: `That's ${CONTACT_PER_DAY} messages today. Try again tomorrow.` });
      const from = me.name || 'A 4flieks Lab member';
      const sent = await ops.sendEmailTo({
        to: t.email, replyTo: me.email,
        subject: `${from} found you on the 4flieks talent search`,
        text: [`Hi ${t.name},`, '', `${from} found your profile on the 4flieks talent search and sent you this message:`, '', message, '',
          `Just reply to this email to answer them. It goes straight to ${from}${me.email ? ` (${me.email})` : ''}.`,
          'Your email address was not shown to them; they will see it only if you reply.', '',
          `You're in the talent search because you switched it on. Turn it off any time at ${ops.SITE}/talent`, '', '4flieks'].join('\n')
      });
      if (!sent || !sent.ok) {
        if (!me.unlimited) await ops.dbIncrement(countPath, -1).catch(() => {});
        return reply(502, { message: 'The email could not be sent. Try again in a minute.' });
      }
      await ops.dbWrite(`flieks_ops/talent_contacted/${me.uid}/${id}`, Date.now());
      await ops.logLabEvent('talent_contact', me.uid, { title: t.name });
      return reply(200, { ok: true });
    }

    return reply(400, { message: 'Unknown action.' });
  } catch (e) {
    console.error('[talent]', e);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};
