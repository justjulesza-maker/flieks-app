/**
 * flieks-board — the Lab opportunities board: casting calls, crew calls, collaborators.
 *
 * The page never touches the database; everything comes through here, and this
 * checks the caller before doing anything (audit: the server secret bypasses the rules).
 *
 * Anyone:
 *   list    { kind?, q?, country?, pay? }   open, approved posts
 *   get     { id }                          one post (owners and admins also see it before approval)
 *   report  { id, reason }                  flag a post to the team (rate limited)
 * Signed in:
 *   mine                                    my posts and my applications
 *   save    { id?, post }                   create or edit a post; every edit goes back for approval
 *   close / reopen / delete { id }
 *   budgets                                 my budgets, to fill roles from
 *   from-budget { prodId }                  suggested roles from a budget's cast and crew lines
 *   apply   { id, roleId, note, answers, reel, guardian? }   verified email; once per role
 *   withdraw { appId }
 *   apps    { id }                          owner: applications, by role
 *   move    { id, appId, folder }           owner: review | shortlist | hire | no ("no" never notifies)
 *   note    { id, appId, note }             owner: private note
 *   message { id, appId, message }          owner: email the applicant; replies go to the owner; emails never shown
 * Admin:
 *   admin-list                              every post with flags and reports
 *   decide  { id, approve, reason? }        approve (live) or decline, the poster is told
 *   takedown { id }
 *
 * Data (all server-only in the rules):
 *   flieks_board_posts/<id>                 post, with owner, owner_email, status, flags
 *   flieks_board_apps/<postId>/<appId>      application, with the applicant's email (never sent to the owner)
 *   flieks_board_my_apps/<uid>/<appId>      { post_id, role_id, at }
 *   flieks_board_reports/<postId>/<who>     { reason, at }
 */
const crypto = require('crypto');
const ops = require('../lib/ops-core');
const core = require('../lib/board-core');
const { card, record } = require('../lib/talent');
const budgetCore = require('../lib/budget-core');

const MAX_OPEN_POSTS = 10;
const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  body: JSON.stringify(obj)
});
const TEAM = () => process.env.OPS_EMAIL_TO || process.env.SUPPORT_EMAIL;
const newPostId = () => 'b' + crypto.randomBytes(7).toString('hex');
const appIdFor = (uid, postId, roleId) => 'a' + crypto.createHash('sha256').update(`${uid}:${postId}:${roleId}`).digest('hex').slice(0, 20);
const day = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const hour = () => new Date().toISOString().slice(0, 13).replace(/[-:T]/g, '');
const slot = (path, limit) => ops.takeSlot(path, limit).catch(() => false);   // fails closed (audit L8)
const ipKey = h => crypto.createHash('sha256').update(String(h['x-nf-client-connection-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim() + ':' + String(process.env.FIREBASE_DB_SECRET)).digest('hex').slice(0, 20);

async function lookup(token) {
  const key = process.env.FIREBASE_API_KEY;
  if (!token || typeof token !== 'string' || !key) return null;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token })
  });
  const u = ((await r.json().catch(() => ({}))).users || [])[0];
  if (!u || typeof u.localId !== 'string' || !/^[A-Za-z0-9]{10,128}$/.test(u.localId)) return null;
  const profile = await ops.dbGet(`flieks_users/${u.localId}`) || {};
  const role = profile.role || 'viewer';
  return { uid: u.localId, email: u.email || '', role, name: core.str(profile.name, 80), verified: !!u.emailVerified };
}
const canAct = me => me.verified || me.role === 'filmmaker' || me.role === 'admin';
const verifyFirst = () => reply(403, { code: 'verify', message: 'Confirm your email first: open the link we sent you, then try again.' });
const validPost = id => typeof id === 'string' && core.POST_ID.test(id);
const validApp = id => typeof id === 'string' && core.APP_ID.test(id);

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { message: 'Bad request.' }); }
  if (!b || typeof b !== 'object') return reply(400, { message: 'Bad request.' });
  const a = b.action, h = event.headers || {};

  try {
    /* ---------------- anyone ---------------- */
    if (a === 'list') {
      const all = await ops.dbGet('flieks_board_posts') || {};
      const kind = core.KINDS.includes(b.kind) ? b.kind : '', pay = core.PAY.includes(b.pay) ? b.pay : '';
      const q = core.str(b.q, 60).toLowerCase(), country = core.str(b.country, 60).toLowerCase();
      const items = Object.entries(all).filter(([id, p]) => core.POST_ID.test(id) && core.isOpen(p) && !p.hidden_reports)
        .map(([id, p]) => core.publicPost(id, p))
        .filter(p => (!kind || p.kind === kind) && (!pay || p.pay_type === pay) && (!country || (p.country || '').toLowerCase() === country || p.remote))
        .filter(p => !q || [p.title, p.company, p.poster, p.synopsis, p.city, ...p.roles.map(r => r.name + ' ' + r.discipline + ' ' + (r.languages || []).join(' '))].join(' ').toLowerCase().includes(q))
        .sort((x, y) => (y.published_at || 0) - (x.published_at || 0)).slice(0, 200);
      return reply(200, { items });
    }

    if (a === 'report') {
      if (!validPost(b.id)) return reply(404, { message: 'Not found.' });
      const reason = core.str(b.reason, 300);
      if (reason.length < 5) return reply(400, { message: 'Tell us what is wrong (a few words).' });
      const who = ipKey(h);
      if (!(await slot(`flieks_ops/board_rate/report/${hour()}/${who}`, 5))) return reply(429, { message: 'Thanks, we have your reports. Try again later.' });
      const p = await ops.dbGet(`flieks_board_posts/${b.id}`);
      if (!p) return reply(404, { message: 'Not found.' });
      await ops.dbWrite(`flieks_board_reports/${b.id}/${who}`, { reason, at: Date.now() });
      const reports = await ops.dbGet(`flieks_board_reports/${b.id}`) || {};
      // Three different people reporting takes the post off the board until the team looks.
      if (Object.keys(reports).length >= 3 && !p.hidden_reports) await ops.dbWrite(`flieks_board_posts/${b.id}/hidden_reports`, true);
      if (TEAM() && (await slot(`flieks_ops/board_rate/report_mail/${b.id}/${day()}`, 1))) {
        await ops.sendEmailTo({ to: TEAM(), subject: `Board post reported: ${p.title}`,
          text: `Someone reported "${p.title}" on the Lab board:\n\n${reason}\n\nCheck it in admin → Everything: ${ops.SITE}/admin#everything` }).catch(() => {});
      }
      return reply(200, { ok: true });
    }

    const me = await lookup(b.token).catch(() => null);

    if (a === 'get') {
      if (!validPost(b.id)) return reply(404, { message: 'Not found.' });
      const p = await ops.dbGet(`flieks_board_posts/${b.id}`);
      const owner = !!(me && p && p.owner === me.uid), admin = !!(me && me.role === 'admin');
      if (!p || (!(core.isOpen(p) && !p.hidden_reports) && !owner && !admin)) return reply(404, { message: 'This opportunity has closed or is no longer on the board.' });
      const out = core.publicPost(b.id, p);
      out.open = core.isOpen(p) && !p.hidden_reports;
      if (owner || admin) { out.is_owner = owner; out.flags = p.flags || []; out.decline_reason = p.decline_reason || ''; out.prod_id = p.prod_id || ''; }
      if (me) {
        const mine = await ops.dbGet(`flieks_board_my_apps/${me.uid}`) || {};
        out.applied = Object.values(mine).filter(x => x && x.post_id === b.id).map(x => x.role_id);
      }
      return reply(200, { post: out });
    }

    /* ---------------- signed in ---------------- */
    if (!me) return reply(401, { message: 'Please sign in.' });

    if (a === 'mine') {
      const all = await ops.dbGet('flieks_board_posts') || {};
      const posts = [];
      for (const [id, p] of Object.entries(all)) {
        if (!p || p.owner !== me.uid || !core.POST_ID.test(id)) continue;
        posts.push({ ...core.publicPost(id, p), flags: p.flags || [], decline_reason: p.decline_reason || '', applications: Number(p.app_count) || 0,
          open: core.isOpen(p) && !p.hidden_reports, hidden_reports: !!p.hidden_reports, updated_at: p.updated_at || 0 });
      }
      posts.sort((x, y) => y.updated_at - x.updated_at);
      const myApps = await ops.dbGet(`flieks_board_my_apps/${me.uid}`) || {};
      const apps = [];
      for (const [appId, x] of Object.entries(myApps)) {
        if (!x || !validApp(appId) || !validPost(x.post_id)) continue;
        const p = all[x.post_id]; const role = p ? core.publicPost(x.post_id, p).roles.find(r => r.id === x.role_id) : null;
        const app = p ? await ops.dbGet(`flieks_board_apps/${x.post_id}/${appId}/folder`) : null;
        apps.push({ appId, post_id: x.post_id, title: p ? p.title : 'Removed', role: role ? role.name : '', at: x.at,
          status: !p ? 'closed' : app === 'hire' ? 'hired' : core.isOpen(p) ? 'applied' : 'closed' });   // shortlist and no are never shown
      }
      apps.sort((x, y) => y.at - x.at);
      return reply(200, { posts, apps, verified: me.verified, role: me.role, name: me.name });
    }

    if (a === 'budgets') {
      const idx = await ops.dbGet(`flieks_budget_index/${me.uid}`) || {};
      return reply(200, { items: Object.entries(idx).filter(([k]) => budgetCore.ID.test(k)).map(([id, v]) => ({ id, title: core.str(v && v.title, 120) })) });
    }

    if (a === 'from-budget') {
      if (typeof b.prodId !== 'string' || !budgetCore.ID.test(b.prodId)) return reply(400, { message: 'Bad id.' });
      const prod = await ops.dbGet(`flieks_budgets/${me.uid}/${b.prodId}`);   // only my own budgets: the path is mine
      if (!prod) return reply(404, { message: 'Budget not found.' });
      const clean = budgetCore.cleanProduction(prod, prod);
      const roles = [];
      clean.sections.forEach(s => s.lines.forEach(l => {
        if (!l.role || roles.length >= 30) return;
        const n = Math.max(1, Math.min(10, Math.round(l.qty) || 1));
        const base = l.desc.replace(/\s*\(.*?\)\s*/g, '').replace(/ — prep$/, '').trim() || 'Role';
        for (let i = 1; i <= n && roles.length < 30; i++) {
          roles.push({ id: 'r' + crypto.randomBytes(5).toString('hex'), name: base + (n > 1 ? ' ' + i : ''), type: l.role === 'cast' ? 'supporting' : 'crew',
            rate: l.rate || null, rate_unit: l.unit === 'Flat' ? 'flat' : l.unit === 'Week' ? 'week' : 'day', description: '', open: true });
        }
      }));
      const title = clean.title;
      return reply(200, { roles, title, format: { short: 'Short', feature: 'Feature', series: 'Series', music: 'Music video' }[clean.type] || 'Other',
        shoot_start: (clean.shootDays.map(d => d.date).filter(Boolean).sort()[0]) || '' });
    }

    if (a === 'save') {
      if (!canAct(me)) return verifyFirst();
      if (b.id !== undefined && !validPost(b.id)) return reply(400, { message: 'Bad id.' });
      const c = core.cleanPost(b.post);
      const why = core.problems(c); if (why) return reply(400, { message: why });
      if (c.prod_id && !(await ops.dbGet(`flieks_budget_index/${me.uid}/${c.prod_id}`))) c.prod_id = '';   // only link my own budget
      if (!(await slot(`flieks_ops/board_rate/save/${day()}/${me.uid}`, 40))) return reply(429, { message: 'That is a lot of saving for one day. Try again tomorrow.' });
      const flags = core.scamFlags(c);
      const admin = me.role === 'admin', now = Date.now();
      const status = admin ? 'live' : 'pending';                         // every post by a member is checked by the team first
      let id = b.id, prev = null;
      if (id) {
        prev = await ops.dbGet(`flieks_board_posts/${id}`);
        if (!prev || prev.owner !== me.uid) return reply(404, { message: 'Not found.' });
      } else {
        let ok;
        try {
          ok = await ops.withLock(`board_${me.uid}`, async () => {
            const all = await ops.dbGet('flieks_board_posts') || {};
            const open = Object.values(all).filter(p => p && p.owner === me.uid && ['pending', 'live'].includes(p.status) && p.closes >= core.today()).length;
            if (open >= MAX_OPEN_POSTS) return false;
            id = newPostId();
            await ops.dbWrite(`flieks_board_posts/${id}`, { owner: me.uid, status: 'draft', created_at: now });
            return true;
          });
        } catch (e) { if (e.busy) return reply(429, { message: 'Busy. Try again in a moment.' }); throw e; }
        if (!ok) return reply(429, { message: `You can have ${MAX_OPEN_POSTS} open posts at a time. Close one to post another.` });
      }
      const rec = Object.assign({}, c, {
        owner: me.uid, owner_email: me.email, poster_name: c.company || me.name || 'A 4flieks Lab member',
        status, flags, created_at: prev ? prev.created_at || now : now, updated_at: now,
        approved_at: admin ? now : null, decline_reason: '', app_count: prev ? Number(prev.app_count) || 0 : 0,
        hidden_reports: prev && prev.hidden_reports && !admin ? true : null
      });
      await ops.dbWrite(`flieks_board_posts/${id}`, rec);
      if (!admin && TEAM() && (await slot(`flieks_ops/board_rate/review_mail/${id}/${day()}`, 1))) {
        await ops.sendEmailTo({ to: TEAM(), subject: `Board post to approve: ${c.title}${flags.length ? ' (flagged)' : ''}`,
          text: `${me.name || me.email} ${prev ? 'edited' : 'posted'} "${c.title}" on the Lab board.${flags.length ? `\n\nFlagged: ${flags.join(', ')}` : ''}\n\nApprove or decline in admin → Everything: ${ops.SITE}/admin#everything` }).catch(() => {});
      }
      if (!prev) ops.logLabEvent('board_post', me.uid, { title: c.title });
      return reply(200, { id, status, flags });
    }

    if (a === 'close' || a === 'reopen' || a === 'delete') {
      if (!validPost(b.id)) return reply(400, { message: 'Bad id.' });
      const p = await ops.dbGet(`flieks_board_posts/${b.id}`);
      if (!p || (p.owner !== me.uid && me.role !== 'admin')) return reply(404, { message: 'Not found.' });
      if (a === 'delete') {
        const apps = await ops.dbGet(`flieks_board_apps/${b.id}`) || {};
        for (const [appId, x] of Object.entries(apps)) if (x && x.uid && validApp(appId)) await ops.dbWrite(`flieks_board_my_apps/${x.uid}/${appId}`, null);
        await ops.dbWrite(`flieks_board_apps/${b.id}`, null);
        await ops.dbWrite(`flieks_board_reports/${b.id}`, null);
        await ops.dbWrite(`flieks_board_posts/${b.id}`, null);
        return reply(200, { ok: true });
      }
      if (a === 'close') { await ops.dbWrite(`flieks_board_posts/${b.id}/status`, 'closed'); return reply(200, { ok: true }); }
      // reopen: back to the team if it was closed; never skips approval
      if (p.status !== 'closed') return reply(400, { message: 'Only a closed post can be reopened.' });
      if (!p.closes || p.closes < core.today()) return reply(400, { message: 'Edit the post and set a new closing date first.' });
      await ops.dbWrite(`flieks_board_posts/${b.id}/status`, me.role === 'admin' || p.approved_at ? (p.flags && p.flags.length ? 'pending' : 'live') : 'pending');
      return reply(200, { ok: true });
    }

    if (a === 'apply') {
      if (!canAct(me)) return verifyFirst();
      if (!validPost(b.id) || typeof b.roleId !== 'string' || !core.ID.test(b.roleId)) return reply(400, { message: 'Bad request.' });
      const p = await ops.dbGet(`flieks_board_posts/${b.id}`);
      if (!p || !core.isOpen(p) || p.hidden_reports) return reply(410, { message: 'This opportunity has closed.' });
      if (p.owner === me.uid) return reply(400, { message: 'This is your own post.' });
      const role = (Array.isArray(p.roles) ? p.roles : Object.values(p.roles || {})).find(r => r && r.id === b.roleId);
      if (!role || role.open === false) return reply(410, { message: 'That role is no longer open.' });
      const talent = await ops.dbGet(`flieks_talent/${me.uid}`);
      const c = core.cleanApplication(b, (p.questions || []).length);
      if (role.minors && !c.guardian) return reply(400, { message: 'This role is for under-18s: a parent or guardian must apply and give consent.' });
      if (role.minors && c.guardian.name.length < 2) return reply(400, { message: 'Add the parent or guardian\'s name.' });
      if (!talent && c.note.length < 20) return reply(400, { message: 'Tell them a little about yourself (a sentence or two), or make a talent profile first.' });
      const appId = appIdFor(me.uid, b.id, b.roleId);
      if (await ops.dbGet(`flieks_board_apps/${b.id}/${appId}/uid`)) return reply(409, { message: 'You have already applied for this role.' });
      if (!(await slot(`flieks_ops/board_rate/apply/${day()}/${me.uid}`, 30))) return reply(429, { message: 'That is 30 applications today. Try again tomorrow.' });
      const name = core.str((talent && talent.name) || me.name, 80) || 'A 4flieks member';
      const now = Date.now();
      await ops.dbWrite(`flieks_board_apps/${b.id}/${appId}`, { uid: me.uid, email: me.email, role_id: b.roleId, name, has_profile: !!talent, ...c, folder: 'review', at: now });
      await ops.dbWrite(`flieks_board_my_apps/${me.uid}/${appId}`, { post_id: b.id, role_id: b.roleId, at: now });
      await ops.dbIncrement(`flieks_board_posts/${b.id}/app_count`, 1).catch(() => {});
      if (p.owner_email && (await slot(`flieks_ops/board_rate/new_app_mail/${b.id}/${day()}`, 1))) {
        await ops.sendEmailTo({ to: p.owner_email, subject: `New applications for "${p.title}"`,
          text: `You have new applications for "${p.title}" on the 4flieks Lab board.\n\nSee them here: ${ops.SITE}/lab/board/manage/${b.id}\n\n(We send at most one of these a day per post.)\n\n4flieks` }).catch(() => {});
      }
      ops.logLabEvent('board_apply', me.uid, { title: p.title });
      return reply(200, { ok: true, appId });
    }

    if (a === 'withdraw') {
      if (!validApp(b.appId)) return reply(400, { message: 'Bad request.' });
      const mine = await ops.dbGet(`flieks_board_my_apps/${me.uid}/${b.appId}`);
      if (!mine || !validPost(mine.post_id)) return reply(404, { message: 'Not found.' });
      const app = await ops.dbGet(`flieks_board_apps/${mine.post_id}/${b.appId}`);
      if (app && app.uid === me.uid) {
        await ops.dbWrite(`flieks_board_apps/${mine.post_id}/${b.appId}`, null);
        await ops.dbIncrement(`flieks_board_posts/${mine.post_id}/app_count`, -1).catch(() => {});
      }
      await ops.dbWrite(`flieks_board_my_apps/${me.uid}/${b.appId}`, null);
      return reply(200, { ok: true });
    }

    if (['apps', 'move', 'note', 'message'].includes(a)) {
      if (!validPost(b.id)) return reply(400, { message: 'Bad id.' });
      const p = await ops.dbGet(`flieks_board_posts/${b.id}`);
      if (!p || p.owner !== me.uid) return reply(404, { message: 'Not found.' });

      if (a === 'apps') {
        const apps = await ops.dbGet(`flieks_board_apps/${b.id}`) || {};
        const out = [];
        for (const [appId, x] of Object.entries(apps)) {
          if (!x || !validApp(appId)) continue;
          let profile = null;
          if (x.has_profile) {
            const t = await ops.dbGet(`flieks_talent/${x.uid}`);
            // Applying shares your profile with this poster, even when you're not in the talent search.
            if (t && !t.hidden_by_admin) { const c = card(x.uid, t, await record(t).catch(() => null)); profile = { ...c, id: undefined }; }
          }
          out.push({ appId, role_id: x.role_id, name: x.name, note: x.note || '', answers: x.answers || [], reel: x.reel || '',
            guardian: x.guardian ? { name: x.guardian.name } : null, folder: core.FOLDERS.includes(x.folder) ? x.folder : 'review',
            private_note: x.private_note || '', at: x.at, profile, messaged_at: x.messaged_at || null });   // never the applicant's email or uid
        }
        out.sort((x, y) => y.at - x.at);
        return reply(200, { post: { ...core.publicPost(b.id, p), prod_id: p.prod_id || '' }, apps: out });
      }

      if (!validApp(b.appId)) return reply(400, { message: 'Bad request.' });
      if (a === 'move' && !core.FOLDERS.includes(b.folder)) return reply(400, { message: 'Bad folder.' });
      const app = await ops.dbGet(`flieks_board_apps/${b.id}/${b.appId}`);
      if (!app) return reply(404, { message: 'Not found.' });

      if (a === 'note') {
        await ops.dbWrite(`flieks_board_apps/${b.id}/${b.appId}/private_note`, core.text(b.note, 1000));
        return reply(200, { ok: true });
      }

      if (a === 'move') {
        if (!core.FOLDERS.includes(b.folder)) return reply(400, { message: 'Bad folder.' });
        await ops.dbWrite(`flieks_board_apps/${b.id}/${b.appId}/folder`, b.folder);
        let added = false;
        if (b.folder === 'hire' && app.folder !== 'hire') {
          const role = (Array.isArray(p.roles) ? p.roles : Object.values(p.roles || {})).find(r => r && r.id === app.role_id) || {};
          // Hired people join the linked production's cast & crew, ready for call sheets.
          if (p.prod_id && budgetCore.ID.test(p.prod_id)) {
            const prod = await ops.dbGet(`flieks_budgets/${me.uid}/${p.prod_id}`);
            if (prod) {
              const cast = p.kind === 'casting' && role.type !== 'crew';
              const contacts = Array.isArray(prod.contacts) ? prod.contacts : Object.values(prod.contacts || {});
              contacts.push({ id: 'c' + crypto.randomBytes(6).toString('hex'), kind: cast ? 'cast' : 'crew', name: app.name,
                role: cast ? '' : role.name, character: cast ? role.name : '', dept: cast ? 'Cast' : 'Production', phone: '', email: '' });
              const clean = budgetCore.cleanProduction(Object.assign({}, prod, { contacts }), prod);
              clean.created_at = prod.created_at; clean.updated_at = Date.now();
              await ops.dbWrite(`flieks_budgets/${me.uid}/${p.prod_id}`, clean);
              added = true;
            }
          }
          if (app.email && (await slot(`flieks_ops/board_rate/hire_mail/${b.appId}`, 1))) {
            await ops.sendEmailTo({ to: app.email, replyTo: me.email, subject: `You got it: ${role.name || 'a role'} in "${p.title}"`,
              text: [`Hi ${app.name},`, '', `${p.poster_name || 'The production'} would like you for ${role.name || 'the role'} in "${p.title}".`, '',
                'Reply to this email to talk details with them directly.', '', '4flieks Lab'].join('\n') }).catch(() => {});
          }
        }
        return reply(200, { ok: true, added_to_budget: added });
      }

      if (a === 'message') {
        const message = core.text(b.message, 1200);
        if (message.length < 10) return reply(400, { message: 'Write a little more.' });
        if (!app.email) return reply(410, { message: 'We cannot reach this person.' });
        if (!(await slot(`flieks_ops/board_rate/message/${day()}/${me.uid}`, 40))) return reply(429, { message: 'That is 40 messages today. Try again tomorrow.' });
        const role = (Array.isArray(p.roles) ? p.roles : Object.values(p.roles || {})).find(r => r && r.id === app.role_id) || {};
        const sent = await ops.sendEmailTo({ to: app.email, replyTo: me.email, subject: `About your application: ${role.name || 'a role'} in "${p.title}"`,
          text: [`Hi ${app.name},`, '', `${p.poster_name || 'The production'} wrote to you about your application on the 4flieks Lab board:`, '', message, '',
            'Reply to this email to answer them. Your email address was not shown to them; they will see it only if you reply.', '', '4flieks Lab'].join('\n') });
        if (!sent || !sent.ok) return reply(502, { message: 'The email could not be sent. Try again in a minute.' });
        await ops.dbWrite(`flieks_board_apps/${b.id}/${b.appId}/messaged_at`, Date.now());
        return reply(200, { ok: true });
      }
    }

    /* ---------------- admin ---------------- */
    if (me.role !== 'admin') return reply(403, { message: 'Admin only.' });

    if (a === 'admin-list') {
      const [all, reports] = await Promise.all([ops.dbGet('flieks_board_posts'), ops.dbGet('flieks_board_reports')]);
      const items = Object.entries(all || {}).filter(([id, p]) => p && core.POST_ID.test(id)).map(([id, p]) => ({
        ...core.publicPost(id, p), flags: p.flags || [], hidden_reports: !!p.hidden_reports, owner_email: p.owner_email || '',
        reports: Object.values((reports || {})[id] || {}).map(r => core.str(r && r.reason, 300)), applications: Number(p.app_count) || 0,
        changed_at: p.updated_at || p.created_at || 0 }));
      items.sort((x, y) => y.changed_at - x.changed_at);
      return reply(200, { items });
    }

    if (a === 'decide' || a === 'takedown') {
      if (!validPost(b.id)) return reply(400, { message: 'Bad id.' });
      const p = await ops.dbGet(`flieks_board_posts/${b.id}`);
      if (!p) return reply(404, { message: 'Not found.' });
      const approve = a === 'decide' && b.approve === true;
      const reason = core.str(b.reason, 300);
      await ops.dbWrite(`flieks_board_posts/${b.id}`, Object.assign({}, p, approve
        ? { status: 'live', approved_at: Date.now(), decline_reason: '', hidden_reports: null }
        : { status: a === 'takedown' ? 'closed' : 'declined', decline_reason: reason || (a === 'takedown' ? 'Taken down by 4flieks.' : 'Not approved.') }));
      if (p.owner_email) {
        await ops.sendEmailTo({ to: p.owner_email, replyTo: TEAM(), subject: approve ? `Your post is live: ${p.title}` : `Your post "${p.title}" is not on the board`,
          text: approve ? `Hi,\n\n"${p.title}" is now on the 4flieks Lab board: ${ops.SITE}/lab/board/p/${b.id}\n\nApplications will show up at ${ops.SITE}/lab/board/manage/${b.id}\n\n4flieks`
            : `Hi,\n\n"${p.title}" is not on the 4flieks Lab board${reason ? `:\n\n${reason}` : '.'}\n\nYou can edit it and send it again, or reply to this email to talk to us.\n\n4flieks` }).catch(() => {});
      }
      return reply(200, { ok: true });
    }

    return reply(400, { message: 'Unknown action.' });
  } catch (e) {
    console.error('[flieks-board]', a, e && e.message);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};

