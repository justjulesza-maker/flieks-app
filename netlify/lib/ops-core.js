/**
 * ops-core — what's happening on 4flieks, for the control centre and the
 * WhatsApp/email agent.
 *
 * buildFacts()     reads the database and works out sales, sign-ups, what's
 *                  waiting on Julian, and what looks broken.
 * writeBriefing()  turns those facts into a short plain-English briefing
 *                  (Anthropic API, same key line-coach.js already uses).
 * answer()         answers a question about the business from the same data.
 * notify()         sends a message: WhatsApp via Twilio when configured,
 *                  otherwise email via Resend (already used for support).
 *
 * Environment (Netlify):
 *   FIREBASE_DB_URL, FIREBASE_DB_SECRET, FIREBASE_API_KEY   (existing)
 *   ANTHROPIC_API_KEY                                        (existing)
 *   RESEND_API_KEY                                           (existing)
 *   YOCO_SECRET_KEY                                          (existing)
 *   OPS_EMAIL_TO           where email briefings/alerts go (default SUPPORT_EMAIL)
 *   OPS_MODEL              optional, the model for briefings and answers
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 *   TWILIO_WHATSAPP_FROM   e.g. whatsapp:+14155238886
 *   OPS_WHATSAPP_TO        e.g. whatsapp:+27821234567
 *   TWILIO_TEMPLATE_BRIEFING, TWILIO_TEMPLATE_ALERT   Content SIDs (HX...) of
 *                          approved templates. Without them, plain messages are
 *                          sent, which WhatsApp only delivers within 24 hours
 *                          of you messaging the number (or in Twilio's sandbox).
 */
const https = require('https');

const DB     = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET = process.env.FIREBASE_DB_SECRET;
const SITE   = 'https://4flieks.com';
const MODEL  = process.env.OPS_MODEL || 'claude-sonnet-5';

/* ---------- plumbing ---------- */

function request(url, opts = {}, body = null) {
  return new Promise((resolve, reject) => {
    const r = https.request(url, opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('timeout')));
    if (body) r.write(body);
    r.end();
  });
}

const dbGet = async p => {
  const r = await request(`${DB}/${p}.json?auth=${SECRET}`);
  if (r.status >= 400) throw new Error(`db read ${p}: ${r.status}`);
  return JSON.parse(r.body || 'null');
};
const dbWrite = (p, data, method = 'PUT') => {
  const b = JSON.stringify(data);
  return request(`${DB}/${p}.json?auth=${SECRET}`, {
    method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);
};

async function verifyAdmin(token) {
  const key = process.env.FIREBASE_API_KEY;
  if (!token || !key) return null;
  const b = JSON.stringify({ idToken: token });
  const r = await request(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);
  const u = (JSON.parse(r.body || '{}').users || [])[0];
  if (!u) return null;
  const profile = await dbGet(`flieks_users/${u.localId}`) || {};
  return profile.role === 'admin' ? u : null;
}

/* South Africa is UTC+2 all year. "Today" means today in Johannesburg. */
const SA = 2 * 3600e3, DAY = 864e5;
const dayStart = t => Math.floor((t + SA) / DAY) * DAY - SA;
const rand = n => 'R' + Number(n || 0).toFixed(2);
const mins = ms => Math.round(ms / 60000);
const ago = ms => {
  if (ms < 3600e3) return `${mins(ms)} min`;
  if (ms < DAY) return `${Math.round(ms / 3600e3)} h`;
  const d = Math.round(ms / DAY);
  return `${d} day${d === 1 ? '' : 's'}`;
};

/* Did Yoco take the money for this checkout? Yoco's docs only confirm the
   create-checkout endpoint, so this is defensive: anything other than a
   clear answer comes back as 'unknown', which never triggers an alarm. */
async function yocoCheckoutState(checkoutId) {
  const key = (process.env.YOCO_SECRET_KEY || '').trim();
  if (!key || !checkoutId) return { state: 'unknown' };
  try {
    const r = await request(`https://payments.yoco.com/api/checkouts/${encodeURIComponent(checkoutId)}`, {
      method: 'GET', headers: { Authorization: `Bearer ${key}` }
    });
    if (r.status !== 200) return { state: 'unknown', raw: `http ${r.status}` };
    const c = JSON.parse(r.body || '{}');
    const s = String(c.status || '').toLowerCase();
    // Only a completed checkout means money moved. A paymentId alone can be a declined or
    // abandoned card attempt, so it is not proof of payment.
    if (s === 'completed' || s === 'succeeded' || s === 'paid') return { state: 'paid', raw: s };
    if (s) return { state: 'not-paid', raw: s };
    return { state: 'unknown' };
  } catch { return { state: 'unknown' }; }
}

/* ---------- the facts ---------- */

/* A small log of Lab actions that leave no other trace (pitches, cast
   searches, connect requests, credit claims, opt-ins), for the control centre. */
async function logLabEvent(type, uid, extra) {
  const key = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return dbWrite(`flieks_ops/lab_events/${key}`, { type, uid: uid || null, at: Date.now(), ...(extra || {}) }).catch(() => {});
}

/* 4flieks Lab: who is using the AI tools and what they are making. */
function labFacts({ U, byUser, events, coachUse, coachDone, talent, claims, unlimited, now, today, week, month }) {
  const nameOf = uid => (U[uid] && U[uid].name) || 'Someone';
  const reports = [];
  Object.entries(byUser || {}).forEach(([uid, list]) => Object.entries(list || {}).forEach(([id, r]) => r && reports.push({ id, uid, ...r })));
  const ev = Object.values(events || {}).filter(Boolean);
  const coach = [];
  Object.entries(coachUse || {}).forEach(([uid, jobs]) => Object.entries(jobs || {}).forEach(([jobId, at]) =>
    coach.push({ uid, jobId, at, ...(((coachDone || {})[uid] || {})[jobId] || {}) })));
  const since = (list, from, f = x => x.at) => list.filter(x => (f(x) || 0) >= from).length;
  const created = r => r.created_at;
  const verdicts = {};
  reports.filter(r => r.status === 'done' && r.verdict).forEach(r => { verdicts[r.verdict] = (verdicts[r.verdict] || 0) + 1; });
  const tokens30 = reports.filter(r => (r.created_at || 0) >= month).reduce((s, r) => s + (r.tokens || 0), 0);
  const labUsers = Object.entries(U).filter(([, u]) => u && u.joined_via === 'lab');
  const active = new Set([...reports.filter(r => (r.created_at || 0) >= month).map(r => r.uid),
    ...coach.filter(c => (c.at || 0) >= month).map(c => c.uid)]);
  const T = Object.entries(talent || {}).filter(([, p]) => p);
  const pendingClaims = [];
  Object.entries(claims || {}).forEach(([film, byCast]) => Object.values(byCast || {}).forEach(byUid =>
    Object.values(byUid || {}).forEach(c => c && pendingClaims.push(c))));
  const of = t => ev.filter(e => e.type === t);

  const feed = [
    ...reports.map(r => ({ at: r.created_at, kind: 'report',
      text: `${nameOf(r.uid)} ran a Script Report on "${r.title}"${r.status === 'done' && r.verdict ? ` · ${r.verdict}` : r.status === 'error' ? ' · failed' : r.status !== 'done' ? ' · reading' : ''}`,
      link: `${SITE}/lab/r/${r.id}` })),
    ...coach.map(c => ({ at: c.at, kind: 'coach',
      text: `${nameOf(c.uid)} uploaded ${c.title ? `"${c.title}"` : 'a script'} to Script Coach${c.characters ? ` · ${c.characters} characters` : ''}`,
      link: c.filmSlug ? `${SITE}/script-coach.html?film=${encodeURIComponent(c.filmSlug)}` : null })),
    ...ev.map(e => ({ at: e.at, kind: e.type, link: e.report ? `${SITE}/lab/r/${e.report}` : null,
      text: {
        pitch: `${nameOf(e.uid)} wrote a pitch${e.title ? ` for "${e.title}"` : ''}`,
        cast_search: `${nameOf(e.uid)} searched for cast${e.title ? ` for "${e.title}"` : ''}`,
        connect: `${nameOf(e.uid)} asked an actor to connect${e.title ? ` about "${e.title}"` : ''}`,
        claim: `${nameOf(e.uid)} claimed a credit${e.title ? ` on ${e.title}` : ''}`,
        opt_in: `${nameOf(e.uid)} switched on "suggest me for roles"`,
        funding: `${nameOf(e.uid)} searched for funding${e.title ? ` for "${e.title}"` : ''}`,
        talent_contact: `${nameOf(e.uid)} messaged ${e.title || 'someone'} from the talent search`
      }[e.type] || `${nameOf(e.uid)}: ${e.type}` })),
    ...labUsers.map(([, u]) => ({ at: u.created_at, kind: 'join', text: `${u.name || 'Someone'} joined the Lab`, link: null }))
  ].filter(x => x.at).sort((a, b) => b.at - a.at).slice(0, 14);

  return {
    members: { joinedViaLab: labUsers.length, today: since(labUsers.map(([, u]) => u), today, u => u.created_at),
      last7days: since(labUsers.map(([, u]) => u), week, u => u.created_at), activeLast30days: active.size,
      partnersWithUnlimited: Object.keys(unlimited || {}).length },
    reports: { today: since(reports, today, created), last7days: since(reports, week, created), last30days: since(reports, month, created),
      total: reports.length, failedLast7days: reports.filter(r => r.status === 'error' && (r.created_at || 0) >= week).length,
      verdicts, aiTokensLast30days: tokens30 },
    pitches: { last30days: since(of('pitch'), month), total: of('pitch').length },
    castSearches: { last30days: since(of('cast_search'), month), total: of('cast_search').length },
    connectRequests: { last30days: since(of('connect'), month), total: of('connect').length },
    coach: { uploadsLast30days: since(coach, month), total: coach.length, ready: coach.filter(c => c.filmSlug).length },
    talent: { profiles: T.length, suggestOn: T.filter(([, p]) => p.suggest === true).length,
      actorsSuggestable: T.filter(([, p]) => p.suggest === true && (p.disciplines || []).includes('Actor')).length,
      approvedCredits: T.reduce((s, [, p]) => s + Object.keys(p.credits || {}).length, 0),
      pendingClaims: pendingClaims.length, claimsWaitingOver3days: pendingClaims.filter(c => now - (c.at || now) > 3 * DAY).length },
    recent: feed
  };
}

async function buildFacts({ verifyPayments = true } = {}) {
  const now = Date.now();
  const today = dayStart(now), yesterday = today - DAY, week = today - 6 * DAY, month = today - 29 * DAY;

  const [films, priv, users, txs, payouts, apps, support, moderation,
         labByUser, labEvents, coachUse, coachDone, talent, talentClaims, labUnlimited] = await Promise.all([
    dbGet('flieks_films'), dbGet('flieks_private'), dbGet('flieks_users'),
    dbGet('flieks_transactions'), dbGet('flieks_payouts'),
    dbGet('flieks_filmmaker_applications'), dbGet('flieks_support'), dbGet('flieks_moderation'),
    dbGet('flieks_script_reports_by_user'), dbGet('flieks_ops/lab_events'), dbGet('flieks_script_coach_usage'),
    dbGet('flieks_coach_by_user'), dbGet('flieks_talent'), dbGet('flieks_talent_claims'), dbGet('flieks_lab_unlimited')
  ].map(p => p.catch(() => null)));

  const F = films || {}, U = users || {};
  const titleOf = id => (F[id] && F[id].title) || id;

  /* Sales — real money only (test-mode payments excluded, as everywhere). */
  const all = Object.entries(txs || {}).map(([id, t]) => ({ id, ...t })).filter(t => t && t.mode !== 'test');
  const done = all.filter(t => t.status === 'complete');
  const at = t => t.completed_at || t.created_at || 0;
  const between = (from, to = Infinity) => done.filter(t => at(t) >= from && at(t) < to);
  const sum = list => ({ count: list.length, revenue: +list.reduce((s, t) => s + Number(t.total || 0), 0).toFixed(2) });

  const byFilm = list => {
    const m = {};
    list.forEach(t => {
      const k = t.film_id || '?';
      m[k] = m[k] || { film: titleOf(k), count: 0, revenue: 0, viaCast: 0 };
      m[k].count++; m[k].revenue = +(m[k].revenue + Number(t.total || 0)).toFixed(2);
      if (t.ref) m[k].viaCast++;
    });
    return Object.values(m).sort((a, b) => b.revenue - a.revenue);
  };

  const sales = {
    today: sum(between(today)),
    yesterday: sum(between(yesterday, today)),
    last7days: sum(between(week)),
    last30days: sum(between(month)),
    allTime: sum(done),
    byFilmLast30days: byFilm(between(month)),
    recent: done.sort((a, b) => at(b) - at(a)).slice(0, 15).map(t => ({
      at: at(t), film: t.film_title || titleOf(t.film_id), type: t.type, total: Number(t.total || 0),
      viaCast: t.ref || null
    }))
  };

  /* Checkouts started but not completed in the last 2 days. */
  const pending = all.filter(t => t.status === 'pending'
    && now - (t.created_at || 0) > 10 * 60e3 && now - (t.created_at || 0) < 2 * DAY);
  let paidNoAccess = [], paidHasAccess = [], unverified = 0, abandoned = 0;
  if (verifyPayments) {
    for (const t of pending.slice(0, 20)) {
      const { state, raw } = await yocoCheckoutState(t.checkout_id);
      if (state === 'paid') {
        // Someone may already be able to watch (e.g. they redeemed a gift instead). Only
        // rentals/purchases can be checked this way; gifts go to the buyer as a code.
        const has = t.type !== 'gift' && t.uid && t.film_id
          ? await dbGet(`flieks_purchases/${t.uid}/${t.film_id}`) : null;
        if (has && has.status === 'complete') paidHasAccess.push({ ...t, yoco: raw });
        else paidNoAccess.push({ ...t, yoco: raw });
      }
      else if (state === 'not-paid') abandoned++;
      else unverified++;
    }
  } else unverified = pending.length;

  /* People */
  const userList = Object.entries(U).map(([uid, u]) => ({ uid, ...u }));
  const joined = from => userList.filter(u => (u.created_at || 0) >= from);
  const signups = {
    today: joined(today).length,
    yesterday: userList.filter(u => u.created_at >= yesterday && u.created_at < today).length,
    last7days: joined(week).length,
    total: userList.length,
    viewers: userList.filter(u => (u.role || 'viewer') === 'viewer').length,
    filmmakers: userList.filter(u => u.role === 'filmmaker').length,
    filmmakersAwaitingApproval: userList.filter(u => u.role === 'filmmaker_pending').length,
    admins: userList.filter(u => u.role === 'admin').length,
    recent: userList.filter(u => u.created_at).sort((a, b) => b.created_at - a.created_at).slice(0, 10)
      .map(u => ({ at: u.created_at, name: u.name || 'Someone', role: u.role || 'viewer', email: u.email || '' }))
  };

  /* What needs Julian — most urgent first. */
  const attention = [];
  const add = (level, kind, text, since, link) => attention.push({ level, kind, text, since: since || null, link: link || null });

  paidNoAccess.forEach(t => add('urgent', 'paid-no-access',
    `Paid but no access: ${t.email || 'a buyer'} for ${t.film_title || titleOf(t.film_id)} (${rand(t.total)}), ${ago(now - t.created_at)} ago. Grant it by hand — see README "Someone paid and got nothing".`,
    t.created_at, `${SITE}/admin`));
  paidHasAccess.forEach(t => add('todo', 'double-charge',
    `Possible double charge: ${t.email || 'a buyer'} paid ${rand(t.total)} for ${t.film_title || titleOf(t.film_id)} ${ago(now - t.created_at)} ago but already had access. Check Yoco and refund if charged twice.`,
    t.created_at, `${SITE}/admin`));

  // A film in review with no video yet is waiting on the filmmaker, not on Julian.
  const hasVideo = id => { const p = (priv || {})[id] || {}; return !!(p.video_url || p.bunny_id); };
  // Ready for Julian: a film with its file, a trailer-only submission (approve as
  // coming soon), or a coming-soon title whose film has now been added.
  const ready = (id, f) => hasVideo(id) || !!f.awaiting_film;
  const inReviewAll = Object.entries(F).filter(([, f]) => f.status === 'review');
  const filmAdded = Object.entries(F).filter(([, f]) => f.status === 'soon' && f.film_added_at && !f.awaiting_film)
    .map(([id, f]) => [id, { ...f, submitted_at: f.film_added_at, title: `${f.title || id} (film added, ready to go live)` }]);
  const inReview = inReviewAll.filter(([id, f]) => ready(id, f)).concat(filmAdded);
  inReview.forEach(([id, f]) => {
    const waited = now - (f.submitted_at || now);
    add(waited > 2 * DAY ? 'urgent' : 'todo', 'film-review',
      `${f.title || id} by ${f.filmmaker || 'a filmmaker'} is waiting for review (${ago(waited)})`, f.submitted_at, `${SITE}/admin`);
  });
  inReviewAll.filter(([id, f]) => !ready(id, f)).forEach(([id, f]) => {
    add('fyi', 'awaiting-upload',
      `${f.title || id} by ${f.filmmaker || 'a filmmaker'} — details in, film not uploaded yet (${ago(now - (f.submitted_at || now))})`, f.submitted_at, null);
  });

  Object.entries(apps || {}).filter(([, a]) => a && a.status === 'pending').forEach(([id, a]) => {
    const when = a.applied_at || a.created_at;
    add('todo', 'application', `${a.name || a.email || 'Someone'} applied to be a filmmaker${a.location ? ' (' + a.location + ')' : ''}`, when, `${SITE}/admin`);
  });

  Object.entries(payouts || {}).forEach(([uid, list]) => Object.entries(list || {}).forEach(([pid, p]) => {
    if (p && p.status === 'pending') add('todo', 'payout',
      `${p.filmmaker_name || 'A filmmaker'} requested a payout of ${rand(p.amount)}`, p.requested_at, `${SITE}/admin`);
  }));

  Object.entries(support || {}).filter(([, s]) => s && s.status === 'open').forEach(([ref, s]) => {
    add('todo', 'support', `Support ${ref}: "${s.topic || 'question'}" from ${s.email || 'someone'}`, s.created_at, null);
  });

  Object.entries(F).filter(([, f]) => f.status === 'live').forEach(([id, f]) => {
    const p = (priv || {})[id] || {};
    if (!p.bunny_ready) add('fyi', 'not-streaming', `${f.title || id} is live but not prepared for adaptive streaming yet (plays the heavier fallback file)`, null, `${SITE}/admin`);
    if (!f.poster_url) add('fyi', 'no-poster', `${f.title || id} is live without a poster`, null, null);
    else if (!f.og_image) add('fyi', 'no-preview', `${f.title || id} has no link-preview image, so WhatsApp shares show a cropped poster`, null, null);
  });

  const hidden = Object.values(moderation || {}).filter(m => m && m.at >= week);
  if (hidden.length) add('fyi', 'hidden-reviews', `${hidden.length} review comment${hidden.length === 1 ? '' : 's'} hidden by filmmakers this week`, null, `${SITE}/admin`);

  const lab = labFacts({ U, byUser: labByUser, events: labEvents, coachUse, coachDone, talent, claims: talentClaims,
    unlimited: labUnlimited, now, today, week, month });
  if (lab.reports.failedLast7days) add('fyi', 'lab-failed',
    `${lab.reports.failedLast7days} Script Report${lab.reports.failedLast7days === 1 ? '' : 's'} failed this week — check the Netlify function log for script-report-background`, null, null);
  if (lab.talent.claimsWaitingOver3days) add('fyi', 'lab-claims',
    `${lab.talent.claimsWaitingOver3days} actor credit claim${lab.talent.claimsWaitingOver3days === 1 ? ' is' : 's are'} waiting more than 3 days for a filmmaker to approve`, null, null);

  if (unverified) add('fyi', 'checkouts-unverified',
    `${unverified} checkout${unverified === 1 ? '' : 's'} started but not completed in the last 2 days — probably abandoned; compare with the Yoco dashboard if you expected sales`, null, null);

  // Most urgent first; within a level, money problems before everything
  // else (someone who paid and can't watch comes before a review queue).
  const order = { urgent: 0, todo: 1, fyi: 2 };
  const kindFirst = { 'paid-no-access': 0, 'double-charge': 1, payout: 1, 'film-review': 2, application: 3, support: 4 };
  attention.sort((a, b) => order[a.level] - order[b.level]
    || (kindFirst[a.kind] ?? 9) - (kindFirst[b.kind] ?? 9)
    || (a.since || 0) - (b.since || 0));

  return {
    generatedAt: now,
    sales,
    checkouts: { notCompleted: pending.length, abandoned, paidNoAccess: paidNoAccess.length, possibleDoubleCharge: paidHasAccess.length, unverified },
    signups,
    films: {
      live: Object.values(F).filter(f => f.status === 'live').length,
      inReview: inReview.length,
      awaitingUpload: inReviewAll.filter(([id, f]) => !ready(id, f)).length,
      titles: Object.entries(F).map(([id, f]) => ({ id, title: f.title, status: f.status, filmmaker: f.filmmaker,
        views: f.view_count || 0, owned: f.own_count || 0, rented: f.rent_count || 0, rating: f.rating_avg || null }))
    },
    lab,
    attention,
    // Ids of things that warrant an immediate alert, for the watcher.
    alertKeys: {
      paidNoAccess: paidNoAccess.map(t => t.id),
      filmReview: inReview.map(([id, f]) => `${id}:${f.submitted_at || ''}`),
      application: Object.entries(apps || {}).filter(([, a]) => a && a.status === 'pending').map(([id]) => id),
      payout: Object.values(payouts || {}).flatMap(l => Object.entries(l || {}).filter(([, p]) => p && p.status === 'pending').map(([id]) => id)),
      support: Object.entries(support || {}).filter(([, s]) => s && s.status === 'open').map(([ref]) => ref)
    }
  };
}

/* The facts, minus personal details, for the language model. Names are
   fine (the briefing is for Julian); emails and ids stay out. */
function factsForModel(f) {
  const clone = JSON.parse(JSON.stringify(f));
  delete clone.alertKeys;
  clone.signups.recent = clone.signups.recent.map(({ email, ...u }) => u);
  if (clone.lab) clone.lab.recent = clone.lab.recent.map(({ link, ...e }) => e);
  clone.attention = clone.attention.map(a => ({ ...a, text: a.text.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]') }));
  return clone;
}

/* ---------- the language model ---------- */

async function claude(system, messages, maxTokens = 700) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const body = JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages });
  const r = await request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
               'x-api-key': key, 'anthropic-version': '2023-06-01' }
  }, body);
  const d = JSON.parse(r.body || '{}');
  if (d.error) throw new Error(d.error.message || 'model error');
  return (d.content || []).map(b => b.text || '').join('').trim();
}

const VOICE = `You are the operations assistant for 4flieks, a South African short-film platform run by
Julian. Viewers rent (R25, 48h from first play) or buy (R49) films; filmmakers keep 70% of the
ex-VAT amount; cast members share tracked links. 4flieks Lab (facts.lab) is the free AI toolkit for writers,
filmmakers and actors: Script Reports, one-page pitches, cast match from opted-in actors, Script
Coach and talent profiles. You get a JSON snapshot of the business.
Times are milliseconds since epoch; South Africa is UTC+2. Money is in Rand.
Rules: only state what the data shows — never invent numbers, names or causes. Be direct and brief,
like a sharp colleague texting the boss. Lead with anything marked "urgent", then "todo".`;

async function writeBriefing(facts) {
  const text = await claude(VOICE + `
Write this morning's briefing. Return JSON only: {"headline": "...", "briefing": "..."}.
- headline: one line under 110 characters for a WhatsApp preview, e.g.
  "3 sales (R123) yesterday, 2 sign-ups · 1 film waiting for review".
- briefing: under 170 words, short paragraphs or "- " bullets, in this order: what needs Julian
  (urgent first, say what to do), yesterday's sales vs the day before and the week, sign-ups,
  the Lab in one line when there was activity (new members, Script Reports, pitches, cast
  searches, actors opting in; facts.lab), anything notable (a film or cast link doing well,
  drop-off, abandoned checkouts). If it was a
  quiet day, say so in one line rather than padding.`,
    [{ role: 'user', content: JSON.stringify(factsForModel(facts)) }], 1500);
  return parseBriefing(text, facts);
}

/* Models sometimes wrap JSON in prose or fences, or run long and get cut off. Recover what we can
   so the page and WhatsApp never show raw JSON. */
function parseBriefing(text, facts) {
  const clean = s => String(s || '').trim();
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      const j = JSON.parse(text.slice(a, b + 1));
      if (j.headline || j.briefing) return { headline: clean(j.headline).slice(0, 140) || fallbackHeadline(facts), briefing: clean(j.briefing).slice(0, 2000) };
    } catch {}
  }
  const field = k => {
    const m = text.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)("|$)`));
    if (!m) return '';
    try { return JSON.parse(`"${m[1].replace(/\\$/, '')}"`); } catch { return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'); }
  };
  const headline = field('headline'), briefing = field('briefing');
  if (headline || briefing) return { headline: clean(headline).slice(0, 140) || fallbackHeadline(facts), briefing: clean(briefing).slice(0, 2000) };
  return { headline: fallbackHeadline(facts), briefing: text.startsWith('{') ? '' : text.slice(0, 2000) };
}

/* Used when the model is unavailable, so the morning message still goes. */
function fallbackHeadline(f) {
  const y = f.sales.yesterday, n = f.attention.filter(a => a.level !== 'fyi').length;
  return `${y.count} sale${y.count === 1 ? '' : 's'} (${rand(y.revenue)}) yesterday, ${f.signups.yesterday} sign-up${f.signups.yesterday === 1 ? '' : 's'}` +
         (n ? ` · ${n} thing${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you` : '');
}

async function answer(facts, question, history = []) {
  const msgs = (Array.isArray(history) ? history : []).slice(-6)
    .filter(m => m && m.role && m.content)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 1500) }));
  msgs.push({ role: 'user', content: String(question).slice(0, 600) });
  return claude(VOICE + `
Answer Julian's question from this snapshot. If the snapshot doesn't contain the answer, say what
it does show and what you'd need — don't guess. Plain text, no headings, usually 1–5 sentences.
Snapshot:
${JSON.stringify(factsForModel(facts))}`, msgs, 600);
}

/* ---------- sending ---------- */

async function sendWhatsApp(kind, vars, plainText) {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM, to = process.env.OPS_WHATSAPP_TO;
  if (!sid || !tok || !from || !to) return { ok: false, reason: 'whatsapp not configured' };
  const template = kind === 'alert' ? process.env.TWILIO_TEMPLATE_ALERT : process.env.TWILIO_TEMPLATE_BRIEFING;
  const form = new URLSearchParams({ From: from, To: to });
  if (template) { form.set('ContentSid', template); form.set('ContentVariables', JSON.stringify(vars)); }
  else form.set('Body', plainText.slice(0, 1500));
  const body = form.toString();
  const r = await request(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body),
               Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64') }
  }, body);
  if (r.status >= 300) return { ok: false, reason: `twilio ${r.status}: ${(JSON.parse(r.body || '{}').message || '').slice(0, 160)}` };
  return { ok: true, via: 'whatsapp' };
}

/* Any email through Resend. Used for Julian's alerts and for mail to filmmakers. */
async function sendEmailTo({ to, subject, text, html, replyTo, cc, attachments }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: 'RESEND_API_KEY is not set' };
  if (!to) return { ok: false, reason: 'no recipient' };
  const msg = {
    from: process.env.OPS_EMAIL_FROM || process.env.SUPPORT_FROM || '4flieks <support@4flieks.com>',
    to: [to], subject, text
  };
  if (html) msg.html = html;
  if (replyTo) msg.reply_to = replyTo;
  if (cc && cc !== to) msg.cc = [cc];
  // [{ filename, path: 'https://…' }] — Resend fetches the file itself.
  if (attachments && attachments.length) msg.attachments = attachments;
  const body = JSON.stringify(msg);
  const r = await request('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${key}` }
  }, body);
  if (r.status < 300) return { ok: true, via: 'email' };
  let why = '';
  try { why = (JSON.parse(r.body || '{}').message || '').slice(0, 160); } catch {}
  return { ok: false, reason: `resend ${r.status}${why ? ': ' + why : ''}` };
}

async function sendEmail(subject, text) {
  const to = process.env.OPS_EMAIL_TO || process.env.SUPPORT_EMAIL;
  if (!process.env.RESEND_API_KEY || !to) return { ok: false, reason: 'email not configured' };
  return sendEmailTo({ to, subject, text });
}

/* WhatsApp first; email if WhatsApp isn't set up or fails, so nothing is lost. */
async function notify(kind, headline, fullText) {
  const link = `${SITE}/pulse`;
  const wa = await sendWhatsApp(kind, { 1: headline, 2: link }, `${kind === 'alert' ? '⚠ ' : ''}${headline}\n\n${fullText}\n\n${link}`);
  if (wa.ok) return wa;
  const em = await sendEmail(kind === 'alert' ? `⚠ 4flieks: ${headline}` : `4flieks briefing: ${headline}`, `${fullText}\n\nControl centre: ${link}`);
  return em.ok ? { ...em, whatsapp: wa.reason } : { ok: false, reason: `${wa.reason}; ${em.reason}` };
}

function channelStatus() {
  const wa = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM', 'OPS_WHATSAPP_TO'].every(k => process.env[k]);
  return {
    whatsapp: wa ? (process.env.TWILIO_TEMPLATE_BRIEFING && process.env.TWILIO_TEMPLATE_ALERT ? 'ready' : 'set up, templates missing') : 'not set up',
    email: !process.env.RESEND_API_KEY ? 'not set up (RESEND_API_KEY missing)'
         : !(process.env.OPS_EMAIL_TO || process.env.SUPPORT_EMAIL) ? 'not set up (add OPS_EMAIL_TO in Netlify)' : 'ready',
    model: process.env.ANTHROPIC_API_KEY ? 'ready' : 'not set up'
  };
}

module.exports = { logLabEvent, labFacts, sendEmailTo, SITE, buildFacts, writeBriefing, parseBriefing, fallbackHeadline, answer, notify, channelStatus, verifyAdmin, dbGet, dbWrite, dayStart, SA };
