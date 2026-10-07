/**
 * flieks-crm — the CRM at /crm. Admin only.
 *
 * POST { token, action, ... }
 *   overview                          counts, audiences, recent campaigns, recent preference changes
 *   people                            every account with purchases and email status
 *   person   { uid }                  one account: profile, purchases, prefs, history
 *   set-pref { uid, field, value, note }   record a change the person asked for (email, phone)
 *   export   { uid }                  everything we hold on them (POPIA access request)
 *   films                             live and coming-soon films, for picking
 *   campaigns                         all campaigns, newest first
 *   campaign { id }                   one campaign
 *   save     { id?, ...fields }       create or update a draft
 *   delete   { id }                   delete a draft
 *   preview  { ...fields }            the email as a recipient would see it
 *   audience { name }                 how many it would go to now
 *   test     { id }                   send it to me only
 *   send     { id, expect }           send it (expect = the count the admin saw; refuses if it moved a lot)
 *   resume   { id }                   carry on a send that failed or stalled (skips anyone already sent to)
 *   weekly                            draft this week's "new on 4flieks" now
 */
const ops = require('../lib/ops-core');
const crm = require('../lib/crm');
const wl = require('../lib/watchlist');

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});
const okUid = u => typeof u === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(u);

async function campaignList() {
  return Object.entries((await ops.dbGet('flieks_crm/campaigns')) || {})
    .map(([id, c]) => ({ id, kind: c.kind, audience: c.audience, subject: c.subject, status: c.status,
      created_at: c.created_at, created_by: c.created_by, sent_at: c.sent_at || null, week: c.week || null,
      progress: c.progress || null, error: c.error || null }))
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

async function recentChanges(limit = 25) {
  const log = (await ops.dbGet('flieks_crm/log')) || {};
  const prefs = (await ops.dbGet('flieks_crm/prefs')) || {};
  const rows = [];
  for (const [ekey, entries] of Object.entries(log)) {
    for (const [id, e] of Object.entries(entries || {})) rows.push({ id, ekey, email: (prefs[ekey] || {}).email || '', ...e });
  }
  return rows.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { message: 'Bad request.' }); }
  const admin = await ops.verifyAdmin(b.token).catch(() => null);
  if (!admin) return reply(403, { message: 'Admin only.' });
  const a = b.action;

  try {
    if (a === 'overview') {
      const list = await crm.people();
      const [c, campaigns, changes] = await Promise.all([crm.counts(list), campaignList(), recentChanges()]);
      const audiences = Object.fromEntries(Object.entries(crm.AUDIENCES).map(([k, v]) => [k, { label: v.label, count: c.audiences[k] }]));
      return reply(200, { counts: c, audiences, campaigns: campaigns.slice(0, 8), changes, week: crm.weekKey(),
        weekly: await ops.dbGet(`flieks_crm/weekly/${crm.weekKey()}`), sender: !!process.env.RESEND_API_KEY });
    }

    if (a === 'people') return reply(200, { people: await crm.people() });

    if (a === 'person') {
      if (!okUid(b.uid)) return reply(400, { message: 'Bad request.' });
      const p = (await crm.people()).find(x => x.uid === b.uid);
      if (!p) return reply(404, { message: 'No such account.' });
      const [purchases, prefs, log, films] = await Promise.all([
        ops.dbGet(`flieks_purchases/${b.uid}`), p.ekey ? crm.getPrefs(p.ekey) : null,
        p.ekey ? ops.dbGet(`flieks_crm/log/${p.ekey}`) : null, ops.dbGet('flieks_films')
      ]);
      const title = id => String(id).startsWith('pod_') ? 'Podcast episode' : ((films || {})[id] || {}).title || id;
      return reply(200, {
        person: p, prefs,
        purchases: Object.entries(purchases || {}).map(([id, x]) => ({ id, title: title(id), type: x.type, amount: x.amount || 0,
          at: x.purchased_at || x.created_at || null, sale: crm.isSale(x), source: x.source || null }))
          .sort((x, y) => (y.at || 0) - (x.at || 0)),
        history: Object.entries(log || {}).map(([id, e]) => ({ id, ...e, words: crm.WORDING[e.wording] || null })).sort((x, y) => (y.at || 0) - (x.at || 0))
      });
    }

    if (a === 'set-pref') {
      if (!okUid(b.uid) || !crm.FIELDS.includes(b.field) || typeof b.value !== 'boolean') return reply(400, { message: 'Bad request.' });
      const note = String(b.note || '').trim();
      if (note.length < 4) return reply(400, { message: 'Say how they asked (e.g. "emailed support 7 Oct").' });
      const u = await ops.dbGet(`flieks_users/${b.uid}`);
      if (!u || !wl.validEmail(u.email || '')) return reply(404, { message: 'That account has no email address.' });
      await crm.setPref({ email: u.email, uid: b.uid, field: b.field, value: b.value, source: 'admin', wording: 'admin-v1', by: admin.localId, note });
      return reply(200, { ok: true });
    }

    if (a === 'export') {
      if (!okUid(b.uid)) return reply(400, { message: 'Bad request.' });
      const data = await crm.exportPerson(b.uid);
      await ops.dbWrite(`flieks_crm/exports/${crm.newId()}`, { uid: b.uid, by: admin.localId, at: Date.now() });
      return reply(200, { data });
    }

    if (a === 'films') {
      const films = Object.entries((await ops.dbGet('flieks_films')) || {})
        .filter(([, f]) => f && (f.status === 'live' || f.status === 'soon') && !f.premiere)
        .map(([id, f]) => ({ id, title: f.title || id, status: f.status, filmmaker: f.filmmaker || '', poster: wl.posterOf(f), published_at: f.published_at || null }))
        .sort((x, y) => (y.published_at || 0) - (x.published_at || 0));
      return reply(200, { films });
    }

    if (a === 'campaigns') return reply(200, { campaigns: await campaignList() });

    if (a === 'campaign') {
      if (!crm.okId(b.id)) return reply(400, { message: 'Bad request.' });
      const c = await ops.dbGet(`flieks_crm/campaigns/${b.id}`);
      return c ? reply(200, { campaign: { id: b.id, ...c } }) : reply(404, { message: 'Not found.' });
    }

    if (a === 'save') {
      let prev = {};
      if (b.id) {
        if (!crm.okId(b.id)) return reply(400, { message: 'Bad request.' });
        prev = await ops.dbGet(`flieks_crm/campaigns/${b.id}`);
        if (!prev) return reply(404, { message: 'Not found.' });
        if (prev.status !== 'draft') return reply(409, { message: 'This one has been sent. Duplicate it to send again.' });
      }
      let c;
      try { c = crm.cleanCampaign(b, prev); } catch (e) { return reply(400, { message: e.message }); }
      const id = b.id || crm.newId();
      await ops.dbWrite(`flieks_crm/campaigns/${id}`, { ...prev, ...c, status: 'draft', created_at: prev.created_at || Date.now(),
        created_by: prev.created_by || admin.localId, updated_at: Date.now() });
      return reply(200, { ok: true, id });
    }

    if (a === 'delete') {
      if (!crm.okId(b.id)) return reply(400, { message: 'Bad request.' });
      const c = await ops.dbGet(`flieks_crm/campaigns/${b.id}`);
      if (!c) return reply(404, { message: 'Not found.' });
      if (c.status !== 'draft') return reply(409, { message: 'Sent campaigns are kept as a record.' });
      await ops.dbWrite(`flieks_crm/campaigns/${b.id}`, null);
      return reply(200, { ok: true });
    }

    if (a === 'preview') {
      let c;
      try { c = crm.cleanCampaign({ subject: '(no subject yet)', ...b }); } catch (e) { return reply(400, { message: e.message }); }
      const films = await crm.filmsById(c.films);
      const why = c.kind === 'consent' ? 'consent' : c.kind === 'filmmaker' ? 'filmmaker' : 'news';
      const m = crm.render(c, films, { ekey: null, name: (admin.displayName || 'Thandi'), why });
      return reply(200, { subject: m.subject, html: m.html, text: m.text, missing: c.films.length - films.length });
    }

    if (a === 'audience') {
      if (!crm.AUDIENCES[b.name]) return reply(400, { message: 'Bad request.' });
      const list = await crm.audience(b.name);
      const why = {};
      for (const p of list) why[p.why] = (why[p.why] || 0) + 1;
      return reply(200, { count: list.length, why });
    }

    if (a === 'test') {
      if (!crm.okId(b.id)) return reply(400, { message: 'Bad request.' });
      const c = await ops.dbGet(`flieks_crm/campaigns/${b.id}`);
      if (!c) return reply(404, { message: 'Not found.' });
      if (!admin.email) return reply(400, { message: 'Your account has no email address.' });
      const films = await crm.filmsById(c.films);
      const m = crm.render(c, films, { ekey: null, name: admin.displayName || '', why: 'test' });
      const r = await crm.sendBatch([{ to: admin.email, ...m, subject: `[TEST] ${m.subject}` }]);
      return r.ok ? reply(200, { ok: true, to: admin.email }) : reply(502, { message: r.reason });
    }

    if (a === 'send') {
      if (!crm.okId(b.id)) return reply(400, { message: 'Bad request.' });
      const c = await ops.dbGet(`flieks_crm/campaigns/${b.id}`);
      if (!c) return reply(404, { message: 'Not found.' });
      if (c.status !== 'draft') return reply(409, { message: `This campaign is already ${c.status}.` });
      if (!c.subject) return reply(400, { message: 'Add a subject line first.' });
      if (c.kind !== 'consent' && !String(c.intro || '').trim() && !(c.films || []).length) return reply(400, { message: 'The email is empty. Add some words or films.' });
      if (c.kind === 'consent') {
        const sentBefore = (await campaignList()).some(x => x.kind === 'consent' && x.id !== b.id && ['queued', 'sending', 'sent'].includes(x.status));
        if (sentBefore && !b.again) return reply(409, { message: 'The question email has gone out before. It only goes to people never asked, so another send reaches new accounts only. Send again to confirm.', again: true });
      }
      const n = (await crm.audience(c.audience)).length;
      if (!n) return reply(400, { message: 'Nobody in this audience can receive it right now.' });
      if (typeof b.expect === 'number' && Math.abs(n - b.expect) > Math.max(5, b.expect * 0.1)) {
        return reply(409, { message: `The audience changed from ${b.expect} to ${n}. Check and send again.`, count: n });
      }
      await ops.dbWrite(`flieks_crm/campaigns/${b.id}`, { status: 'queued', queued_at: Date.now(), queued_by: admin.localId, progress: { sent: 0, failed: 0, total: n, at: Date.now() } }, 'PATCH');
      const started = await crm.startSend(b.id);
      if (!started) {
        await ops.dbWrite(`flieks_crm/campaigns/${b.id}`, { status: 'draft' }, 'PATCH');
        return reply(502, { message: 'Could not start sending. Try again in a minute.' });
      }
      return reply(200, { ok: true, count: n });
    }

    if (a === 'resume') {
      if (!crm.okId(b.id)) return reply(400, { message: 'Bad request.' });
      const c = await ops.dbGet(`flieks_crm/campaigns/${b.id}`);
      if (!c) return reply(404, { message: 'Not found.' });
      const last = (c.progress && c.progress.at) || c.queued_at || 0;
      const stalled = ['queued', 'sending'].includes(c.status) && Date.now() - last > 16 * 60e3;
      if (c.status !== 'failed' && !stalled) return reply(409, { message: c.status === 'sent' ? 'Already sent.' : 'It is still sending.' });
      await ops.dbWrite(`flieks_crm/campaigns/${b.id}`, { status: 'queued', error: null, resumed_at: Date.now() }, 'PATCH');
      if (!(await crm.startSend(b.id))) return reply(502, { message: 'Could not start sending. Try again in a minute.' });
      return reply(200, { ok: true });
    }

    if (a === 'weekly') return reply(200, await crm.draftWeekly({ force: !!b.force }));

    return reply(400, { message: 'Unknown action.' });
  } catch (e) {
    console.error('[crm]', a, e);
    return reply(500, { message: 'Something went wrong: ' + String(e.message || e).slice(0, 120) });
  }
};
