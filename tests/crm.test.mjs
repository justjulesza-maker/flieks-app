/**
 * CRM and email consent (POPIA): who may get which email, the one-time question,
 * unsubscribe links and one-click unsubscribe, the admin API, sending, the Monday
 * draft, film-alert suppression and data exports.
 *   node tests/crm.test.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const path = require('path');

process.env.FIREBASE_API_KEY = 'test-key';
process.env.FIREBASE_DB_SECRET = 'test-secret';
process.env.RESEND_API_KEY = 'test-resend';
process.env.URL = 'http://localhost:0';
process.env.OPS_EMAIL_TO = 'team@4flieks.test';

/* ---- in-memory database standing in for ops-core ---- */
const db = {};
const segs = p => String(p).split('/').filter(Boolean);
function get(p) { let o = db; for (const k of segs(p)) { if (o == null || typeof o !== 'object') return null; o = o[k]; } return o === undefined ? null : JSON.parse(JSON.stringify(o)); }
function put(p, v) {
  const ks = segs(p); let o = db;
  for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
  const last = ks[ks.length - 1];
  if (v === null || v === undefined) delete o[last]; else o[last] = JSON.parse(JSON.stringify(v));
}
const emails = [];
const ops = {
  dbGet: async p => get(p),
  dbWrite: async (p, v, method = 'PUT') => {
    if (method === 'PATCH') for (const [k, x] of Object.entries(v || {})) put(`${p}/${k}`, x);   // multi-path, like the REST API
    else put(p, v);
    return { status: 200, body: 'null' };
  },
  withLock: async (name, fn) => fn(),
  SITE: 'https://4flieks.com', SA: 2 * 3600e3,
  dayStart: t => Math.floor((t + 2 * 3600e3) / 864e5) * 864e5 - 2 * 3600e3,
  sendEmailTo: async m => { emails.push(m); return { ok: true }; },
  verifyAdmin: async token => { const u = users[token]; return u && get(`flieks_users/${u.localId}`).role === 'admin' ? u : null; }
};
const opsPath = path.resolve('netlify/lib/ops-core.js');
require.cache[opsPath] = { id: opsPath, filename: opsPath, loaded: true, exports: ops };

const users = {};
function addUser(token, uid, email, extra = {}) {
  users[token] = { localId: uid, email, displayName: extra.name || uid, emailVerified: extra.verified !== false };
  put(`flieks_users/${uid}`, { name: extra.name || uid, email, role: extra.role || 'viewer', created_at: 1 });
}

let batches = [], bgStarts = 0, resendFail = false, rejectAddr = null;
global.fetch = async (url, opts = {}) => {
  url = String(url);
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (url.startsWith('https://identitytoolkit.googleapis.com/')) {
    const { idToken } = JSON.parse(opts.body || '{}');
    return users[idToken] ? json(200, { users: [users[idToken]] }) : json(400, { error: { message: 'INVALID_ID_TOKEN' } });
  }
  if (url === 'https://api.resend.com/emails/batch') {
    if (resendFail) return json(500, { message: 'down' });
    const msgs = JSON.parse(opts.body);
    if (rejectAddr && msgs.some(m => m.to[0] === rejectAddr)) return json(422, { message: 'Invalid `to` field' });
    batches.push(msgs); return json(200, { data: [] });
  }
  if (url.includes('/.netlify/functions/crm-send-background')) { bgStarts++; return json(202, {}); }
  throw new Error('unexpected fetch ' + url);
};

const crm = require('../netlify/lib/crm.js');
const wl = require('../netlify/lib/watchlist.js');
const prefsFn = require('../netlify/functions/flieks-email-prefs.js');
const crmFn = require('../netlify/functions/flieks-crm.js');
const bg = require('../netlify/functions/crm-send-background.js');

let failed = 0, passed = 0;
function check(label, cond, extra) { if (cond) { passed++; console.log('PASS ', label); } else { failed++; console.log('FAIL ', label, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } }
async function call(fn, body, extra = {}) { const r = await fn.handler({ httpMethod: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: {}, ...extra }); let d = {}; try { d = JSON.parse(r.body || '{}'); } catch {} return { status: r.statusCode, d, raw: r.body }; }
const admin = b => call(crmFn, { token: 'tA', ...b });
const prefs = b => call(prefsFn, b);
const K = e => wl.emailKey(e);

/* ---- the people ---- */
addUser('tA', 'adminAAAAAAAAAA', 'julian@4flieks.test', { role: 'admin', name: 'Julian' });
addUser('tV', 'viewerVVVVVVVVV', 'vee@example.com', { name: 'Vee Viewer' });            // no purchase, never chose
addUser('tB', 'buyerBBBBBBBBBB', 'bee@example.com', { name: 'Bee Buyer' });             // bought: customer
addUser('tG', 'giftGGGGGGGGGGG', 'gee@example.com', { name: 'Gee Gift' });              // only redeemed a gift
addUser('tT', 'testTTTTTTTTTTT', 'tee@example.com', { name: 'Tee Test' });              // test-mode payment only
addUser('tF', 'makerFFFFFFFFFF', 'fay@example.com', { role: 'filmmaker', name: 'Fay Maker' });
addUser('tP', 'pendingPPPPPPPP', 'pip@example.com', { role: 'filmmaker_pending', name: 'Pip Pending' });
addUser('tD', 'dupeDDDDDDDDDDD', 'BEE@example.com ', { name: 'Bee Again' });            // same address as Bee, second account
put('flieks_purchases/buyerBBBBBBBBBB/film1', { status: 'complete', mode: 'live', amount: 49, type: 'own', purchased_at: 5 });
put('flieks_purchases/giftGGGGGGGGGGG/film1', { status: 'complete', amount: 0, source: 'gift', type: 'own' });
put('flieks_purchases/testTTTTTTTTTTT/film1', { status: 'complete', mode: 'test', amount: 25, type: 'rent' });
const now = Date.now();
put('flieks_films/film1', { title: 'Metamorph', status: 'live', published_at: now - 2 * 864e5, filmmaker: 'Fay', poster_url: 'https://x.test/p.jpg', price_rent: 25, price_own: 49 });
put('flieks_films/film2', { title: 'Old One', status: 'live', published_at: now - 30 * 864e5 });
put('flieks_films/film3', { title: 'Soon <b>One</b>', status: 'soon' });
put('flieks_films/film4', { title: 'Premiere', status: 'live', premiere: true, published_at: now - 864e5 });

/* ---- status rules ---- */
let ppl = await crm.people();
const by = uid => ppl.find(p => p.uid === uid);
check('never chose, never bought: not asked, no newsletter', by('viewerVVVVVVVVV').news === 'not asked' && !by('viewerVVVVVVVVV').news_ok);
check('bought a film: customer basis, gets newsletter', by('buyerBBBBBBBBBB').news === 'customer' && by('buyerBBBBBBBBBB').news_ok);
check('redeemed a gift only: not a customer', by('giftGGGGGGGGGGG').news === 'not asked');
check('test payment only: not a customer', by('testTTTTTTTTTTT').news === 'not asked');
check('filmmaker gets filmmaker news by default', by('makerFFFFFFFFFF').filmmaker_news === true);
check('spend is counted from real sales', by('buyerBBBBBBBBBB').spend === 49);

let aud = await crm.audience('viewers');
check('viewer audience: only the customer for now', aud.length === 1 && aud[0].email === 'bee@example.com' && aud[0].why === 'customer', aud);
check('strict audience: nobody has said yes yet', (await crm.audience('consented')).length === 0);
const askList = await crm.audience('consent');
check('question audience: never-asked non-buyers, one per address', askList.length === 6 && !askList.some(p => p.ekey === K('bee@example.com')), askList.map(p => p.email));

/* ---- sign-up box ---- */
let r = await prefs({ action: 'signup', token: 'tV', news: true, source: 'signup:home' });
check('sign-up with the box ticked is accepted', r.status === 200);
let pv = get(`flieks_crm/prefs/${K('vee@example.com')}`);
check('ticked box = yes, from the sign-up form', pv && pv.news === true && pv.news_source === 'signup:home');
let log = Object.values(get(`flieks_crm/log/${K('vee@example.com')}`) || {});
check('the yes is logged with the words they saw', log.length === 1 && log[0].wording === 'signup-v1' && log[0].to === true && log[0].from === null, log);
r = await prefs({ action: 'signup', token: 'tG', news: false, source: 'signup:lab' });
check('unticked box records no choice', r.status === 200 && (get(`flieks_crm/prefs/${K('gee@example.com')}`) || {}).news === undefined);
r = await prefs({ action: 'signup', token: 'tG', news: true, source: 'evil' });
check('sign-up refuses an unknown source', r.status === 400);
r = await prefs({ action: 'signup', news: true, source: 'signup:home' });
check('sign-up needs a signed-in person', r.status === 401);

/* ---- links from emails ---- */
const bk = K('bee@example.com'), bt = crm.prefsToken(bk);
check('token checks out for its own address', crm.checkToken(bk, bt));
check('token does not work for another address', !crm.checkToken(K('vee@example.com'), bt));
check('a made-up token fails', !crm.checkToken(bk, 'x'.repeat(32)));
r = await prefs({ action: 'get', k: bk, t: 'y'.repeat(32) });
check('wrong token is refused', r.status === 403);
r = await prefs({ action: 'get', k: bk, t: bt });
check('link shows the address masked, and that they get news as a customer', r.status === 200 && r.d.email === 'b••@example.com' && r.d.prefs.news === true && r.d.prefs.news_basis === 'customer', r.d);
r = await prefs({ action: 'set', k: bk, t: bt, field: 'news', value: false, source: 'unsubscribe-link' });
check('unsubscribe by link works without an existing prefs record', r.status === 200 && r.d.prefs.news === false, r.d);
ppl = await crm.people();
check('the customer who said no is now unsubscribed', by('buyerBBBBBBBBBB').news === 'unsubscribed' && !by('buyerBBBBBBBBBB').news_ok);
r = await prefs({ action: 'set', k: bk, t: bt, field: 'news', value: true, source: 'admin' });
check('a link cannot claim to be an admin change', r.status === 200 && Object.values(get(`flieks_crm/log/${bk}`)).every(e => e.source !== 'admin'));
check('switching back on by link is logged as the preferences page', Object.values(get(`flieks_crm/log/${bk}`)).some(e => e.source === 'prefs-page' && e.to === true));

r = await call(prefsFn, 'List-Unsubscribe=One-Click', { queryStringParameters: { k: bk, t: bt, scope: 'news' } });
check('one-click unsubscribe from a mail app', r.status === 200 && get(`flieks_crm/prefs/${bk}`).news === false);
check('one-click is logged as such', Object.values(get(`flieks_crm/log/${bk}`)).some(e => e.source === 'one-click' && e.to === false));
r = await call(prefsFn, 'List-Unsubscribe=One-Click', { queryStringParameters: { k: bk, t: 'z'.repeat(32), scope: 'news' } });
check('one-click with a bad token is refused', r.status === 403);
await prefs({ action: 'set', k: bk, t: bt, field: 'alerts', value: true });
r = await call(prefsFn, 'LS0tLS0tV2ViS2l0Rm9ybUJvdW5kYXJ5', { isBase64Encoded: true, queryStringParameters: { k: bk, t: bt, scope: 'alerts' } });
check('one-click works whatever the body encoding (multipart/base64)', r.status === 200 && get(`flieks_crm/prefs/${bk}`).alerts === false);

/* double opt-in: an unverified address can't be signed up to news by someone else */
addUser('tU', 'unverifiedUUUUU', 'victim@example.com', { name: 'Not Victim', verified: false });
batches = [];
r = await prefs({ action: 'signup', token: 'tU', news: true, source: 'signup:home' });
const uk = K('victim@example.com');
check('unverified sign-up yes is held as pending', r.status === 200 && r.d.pending === true && get(`flieks_crm/prefs/${uk}`).news === undefined && get(`flieks_crm/prefs/${uk}`).news_pending.source === 'signup:home');
check('and a confirm email goes to the address, with a yes link', batches.flat().length === 1 && batches.flat()[0].to[0] === 'victim@example.com' && batches.flat()[0].html.includes('&amp;yes=1&amp;via=confirm'));
check('pending people get no newsletters', !(await crm.audience('viewers')).some(p => p.ekey === uk));
batches = [];
r = await prefs({ action: 'set', token: 'tU', field: 'news', value: true, source: 'profile' });
check('pressing yes again in the profile does not re-send within a day', r.status === 200 && r.d.pending === true && batches.length === 0 && r.d.prefs.news === false);
r = await prefs({ action: 'set', k: uk, t: crm.prefsToken(uk), field: 'news', value: true, source: 'confirm-email' });
check('the button in the confirm email makes it a yes', r.status === 200 && r.d.prefs.news === true && Object.values(get(`flieks_crm/log/${uk}`)).some(e => e.source === 'confirm-email' && e.wording === 'confirm-email-v1'));
check('pending is cleared once confirmed', get(`flieks_crm/prefs/${uk}`).news_pending == null);
r = await prefs({ action: 'set', token: 'tU', field: 'news', value: false });
check('an unverified person can still say no straight away', r.status === 200 && r.d.prefs.news === false);
delete users.tU; put('flieks_users/unverifiedUUUUU', null); put(`flieks_crm/prefs/${uk}`, null); put(`flieks_crm/log/${uk}`, null);

r = await prefs({ action: 'all-off', token: 'tF' });
check('signed in: unsubscribe from everything', r.status === 200 && r.d.prefs.filmmaker_news === false && r.d.prefs.alerts === false && r.d.filmmaker === true, r.d);
r = await prefs({ action: 'set', token: 'tF', field: 'filmmaker_news', value: true });
check('and switch filmmaker news back on', r.status === 200 && r.d.prefs.filmmaker_news === true);
r = await prefs({ action: 'set', token: 'tF', field: 'role', value: true });
check('only the three email kinds can be set', r.status === 400);

/* ---- admin API ---- */
r = await call(crmFn, { token: 'tV', action: 'overview' });
check('CRM is admin only', r.status === 403);
r = await admin({ action: 'overview' });
check('overview counts', r.status === 200 && r.d.counts.accounts === 8 && r.d.counts.subscribed === 1 && r.d.counts.unsubscribed === 3 && r.d.counts.customer === 0, r.d.counts);   // Bee (both accounts) and Fay (all off)
r = await admin({ action: 'set-pref', uid: 'giftGGGGGGGGGGG', field: 'news', value: true, note: '' });
check('admin change needs a note of how they asked', r.status === 400);
r = await admin({ action: 'set-pref', uid: 'giftGGGGGGGGGGG', field: 'news', value: true, note: 'Emailed support 7 Oct' });
const gl = Object.values(get(`flieks_crm/log/${K('gee@example.com')}`));
check('admin change is logged with who and why', r.status === 200 && gl.some(e => e.source === 'admin' && e.by === 'adminAAAAAAAAAA' && e.note === 'Emailed support 7 Oct'));
r = await admin({ action: 'person', uid: 'giftGGGGGGGGGGG' });
check('person shows history with the words shown', r.status === 200 && r.d.history.length >= 1 && r.d.history[0].words, r.d.history);

r = await admin({ action: 'save', kind: 'newsletter', subject: 'Hello', heading: '<script>alert(1)</script>', intro: 'Para one https://4flieks.com/x\n\nPara <two>', films: ['film1', 'film3', '../bad'], cta_label: 'Go', cta_url: 'javascript:alert(1)' });
check('a button link that isn\'t https is refused', r.status === 400 && /https/.test(r.d.message));
r = await admin({ action: 'save', kind: 'newsletter', subject: 'Hello', heading: '<script>alert(1)</script>', intro: 'Para one https://4flieks.com/x\n\nPara <two>', films: ['film1', 'film3', '../bad'], cta_label: 'Go', cta_url: 'https://4flieks.com' });
const nid = r.d.id;
check('newsletter draft saved', r.status === 200 && crm.okId(nid));
check('bad film ids are dropped', JSON.stringify(get(`flieks_crm/campaigns/${nid}`).films) === '["film1","film3"]');
r = await admin({ action: 'preview', ...get(`flieks_crm/campaigns/${nid}`) });
check('preview escapes the headline', r.status === 200 && !r.d.html.includes('<script>alert') && r.d.html.includes('&lt;script&gt;'));
check('preview escapes film titles', r.d.html.includes('Soon &lt;b&gt;One&lt;/b&gt;'));
check('links in the message are clickable', r.d.html.includes('<a href="https://4flieks.com/x"'));
check('every email names the sender', r.d.html.includes('DiscovrTV (Pty) Ltd') && r.d.text.includes('DiscovrTV (Pty) Ltd'));

r = await admin({ action: 'save', kind: 'consent', subject: 'Q', films: ['film1'], intro: 'Buy now!', cta_label: 'Buy', cta_url: 'https://4flieks.com' });
const qid = r.d.id;
const q = get(`flieks_crm/campaigns/${qid}`);
check('question email carries no films, offers or own words', q.films.length === 0 && !q.intro && !q.cta_url && q.audience === 'consent');

/* ---- sending ---- */
r = await admin({ action: 'audience', name: 'viewers' });
check('audience count before sending', r.status === 200 && r.d.count === 2 && r.d.why.news === 2, r.d);   // Vee (signup) and Gee (admin, on request)
r = await admin({ action: 'send', id: nid, expect: 40 });
check('send refuses when the audience moved a lot since the admin looked', r.status === 409 && r.d.count === 2);
r = await admin({ action: 'send', id: nid, expect: 2 });
check('send queues it and starts the background job', r.status === 200 && bgStarts === 1 && get(`flieks_crm/campaigns/${nid}`).status === 'queued');
r = await admin({ action: 'send', id: nid, expect: 2 });
check('it can\'t be sent twice', r.status === 409);

// Someone unsubscribes after it was queued, before it goes.
await prefs({ action: 'set', token: 'tG', field: 'news', value: false });
r = await call(bg, { id: nid });
check('background job needs its secret', r.status === 403);
const bgr = await bg.handler({ httpMethod: 'POST', body: JSON.stringify({ id: nid }), headers: { 'x-job-secret': crm.jobSecret() } });
check('background job runs', bgr.statusCode === 200);
const sentTo = batches.flat().map(m => m.to[0]);
check('only people who may get it now are sent to', JSON.stringify(sentTo) === '["vee@example.com"]', sentTo);
const m1 = batches.flat()[0];
check('one-click unsubscribe headers on every newsletter', /flieks-email-prefs\?k=e_[a-f0-9]{24}&t=[\w-]{32}&scope=news/.test(m1.headers['List-Unsubscribe']) && m1.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click');
check('their own unsubscribe link is in the email', m1.html.includes(`k=${K('vee@example.com')}&amp;t=${crm.prefsToken(K('vee@example.com'))}&amp;unsub=news`));
check('says why they got it', m1.html.includes('you said yes to 4flieks news'));
check('campaign marked sent with counts', get(`flieks_crm/campaigns/${nid}`).status === 'sent' && get(`flieks_crm/campaigns/${nid}`).progress.sent === 1);
batches = [];
await get(`flieks_crm/campaigns/${nid}`) && put(`flieks_crm/campaigns/${nid}/status`, 'sending');
await crm.runCampaign(nid, { pauseMs: 0 });
check('running it again sends nobody twice', batches.length === 0);

/* the one-time question */
batches = [];
put(`flieks_crm/campaigns/${qid}/status`, 'queued');
let qr = await crm.runCampaign(qid, { pauseMs: 0 });
const asked = batches.flat().map(m => m.to[0]).sort();
check('question goes to people never asked who never chose', JSON.stringify(asked) === JSON.stringify(['julian@4flieks.test', 'pip@example.com', 'tee@example.com']), asked);
check('question email has yes and no buttons', batches.flat()[0].html.includes('&amp;yes=1') && batches.flat()[0].html.includes('&amp;no=1'));
check('and offers no films', !batches.flat()[0].html.includes('Metamorph'));
check('they are marked as asked', !!get(`flieks_crm/prefs/${K('tee@example.com')}`).asked_at);
r = await admin({ action: 'save', kind: 'consent', subject: 'Q again' });
const q2 = r.d.id;
r = await admin({ action: 'send', id: q2 });
check('a second question email needs confirming', r.status === 409 && r.d.again === true);
r = await admin({ action: 'send', id: q2, again: true });
check('and has nobody left to ask', r.status === 400);
ppl = await crm.people();
check('asked people show as asked, still no newsletter', by('testTTTTTTTTTTT').news === 'asked' && !by('testTTTTTTTTTTT').news_ok);
r = await prefs({ action: 'set', k: K('tee@example.com'), t: crm.prefsToken(K('tee@example.com')), field: 'news', value: true, source: 'consent-email' });
check('yes from the question email', r.status === 200 && r.d.prefs.news === true && Object.values(get(`flieks_crm/log/${K('tee@example.com')}`)).some(e => e.wording === 'consent-email-v1'));

/* a failed send is recorded, not lost */
batches = []; resendFail = true;
r = await admin({ action: 'save', kind: 'filmmaker', subject: 'Maker news', intro: 'Hello makers' });
const fid = r.d.id;
put(`flieks_crm/campaigns/${fid}/status`, 'queued');
qr = await crm.runCampaign(fid, { pauseMs: 0 });
check('Resend failing marks the campaign failed with the reason', qr.status === 'failed' && /resend 500/.test(get(`flieks_crm/campaigns/${fid}`).error));
resendFail = false;
put(`flieks_crm/campaigns/${fid}/status`, 'sending');
qr = await crm.runCampaign(fid, { pauseMs: 0 });
check('re-running after a failure sends to the ones that failed', qr.status === 'sent' && batches.flat().map(m => m.to[0]).join() === 'fay@example.com');
check('filmmaker email says why and offers to stop filmmaker news', batches.flat()[0].html.includes('you release films on 4flieks') && batches.flat()[0].headers['List-Unsubscribe'].includes('scope=filmmaker_news'));

/* one bad address doesn't sink the batch */
batches = []; rejectAddr = 'pip@example.com';
r = await admin({ action: 'save', kind: 'filmmaker', audience: 'applicants', subject: 'Applicants', intro: 'Hi' });
const apid = r.d.id;
r = await admin({ action: 'save', kind: 'filmmaker', audience: 'filmmakers', subject: 'Makers 2', intro: 'Hi' });
put(`flieks_crm/campaigns/${apid}/status`, 'queued');
qr = await crm.runCampaign(apid, { pauseMs: 0 });
check('a refused address is recorded as failed, alone', qr.status === 'failed' && get(`flieks_crm/sends/${apid}/${K('pip@example.com')}`).ok === false);
const okR = await crm.sendChunk(crm.sendBatch, [{ to: 'fay@example.com', subject: 'a', text: 'b' }, { to: 'pip@example.com', subject: 'a', text: 'b' }]);
check('a 422 batch is retried one by one so good addresses still get it', okR[0].ok === true && okR[1].ok === false);
rejectAddr = null;

/* stuck or failed sends can be resumed, without double sending */
r = await admin({ action: 'resume', id: nid });
check('a finished send can\'t be resumed', r.status === 409);
put(`flieks_crm/campaigns/${apid}/status`, 'sending');
put(`flieks_crm/campaigns/${apid}/progress/at`, Date.now());
r = await admin({ action: 'resume', id: apid });
check('a send still moving can\'t be resumed', r.status === 409);
put(`flieks_crm/campaigns/${apid}/progress/at`, Date.now() - 20 * 60e3);
const starts = bgStarts;
r = await admin({ action: 'resume', id: apid });
check('a stalled send can be resumed', r.status === 200 && bgStarts === starts + 1 && get(`flieks_crm/campaigns/${apid}`).status === 'queued');
batches = [];
await crm.runCampaign(apid, { pauseMs: 0 });
check('resuming sends to the one who missed it', batches.flat().map(m => m.to[0]).join() === 'pip@example.com');
const realGet = ops.dbGet;
ops.dbGet = async p => { if (p === 'flieks_crm/sends/' + q2) throw new Error('db down'); return realGet(p); };
put(`flieks_crm/campaigns/${q2}/status`, 'queued');
await bg.handler({ httpMethod: 'POST', body: JSON.stringify({ id: q2 }), headers: { 'x-job-secret': crm.jobSecret() } });
ops.dbGet = realGet;
check('a run that crashes is marked failed, not left sending', get(`flieks_crm/campaigns/${q2}`).status === 'failed' && /db down/.test(get(`flieks_crm/campaigns/${q2}`).error));

/* a write that fails is an error, not a quiet success */
const realWrite = ops.dbWrite;
ops.dbWrite = async () => ({ status: 503 });
r = await prefs({ action: 'set', k: K('vee@example.com'), t: crm.prefsToken(K('vee@example.com')), field: 'alerts', value: false });
ops.dbWrite = realWrite;
check('an unsubscribe that could not be saved says so', r.status === 500);

/* test send */
batches = [];
r = await admin({ action: 'test', id: fid });
check('test goes only to the admin, marked TEST', r.status === 200 && batches.flat().length === 1 && batches.flat()[0].to[0] === 'julian@4flieks.test' && batches.flat()[0].subject.startsWith('[TEST]'));
r = await admin({ action: 'delete', id: fid });
check('sent campaigns can\'t be deleted', r.status === 409);

/* ---- Monday draft ---- */
let w = await crm.draftWeekly({ now });
check('weekly draft made from films live in the last 7 days', w.made && w.films === 1);
const wc = get(`flieks_crm/campaigns/${w.id}`);
check('weekly draft leaves out old films and trailer premieres, and is not sent', JSON.stringify(wc.films) === '["film1"]' && wc.status === 'draft' && /Metamorph/.test(wc.subject));
w = await crm.draftWeekly({ now });
check('only one draft a week', !w.made && w.reason === 'already drafted this week');
check('no new films: no draft', !(await crm.draftWeekly({ now: now + 60 * 864e5 })).made);
put('flieks_films/film1/published_at', now + 7 * 864e5);   // taken down and put back live next week
check('a film put back live is not announced as new again', !(await crm.draftWeekly({ now: now + 8 * 864e5 })).made);
put('flieks_films/film1/published_at', now - 2 * 864e5);
check('week key is a Monday', new Date(crm.weekKey(Date.UTC(2026, 9, 7, 10)) + 'T00:00:00Z').getUTCDay() === 1 && crm.weekKey(Date.UTC(2026, 9, 7, 10)) === '2026-10-05');

/* ---- film alerts respect the switch ---- */
put(`flieks_crm/prefs/${K('fay@example.com')}/alerts`, false);
const out = await wl.withUnsubscribe([
  { to: 'fay@example.com', subject: 's', text: 't', html: '<div>x</div></body></html>' },
  { to: 'vee@example.com', subject: 's', text: 't', html: '<div>x</div></body></html>' }]);
check('film alerts skip people who switched them off', out.length === 1 && out[0].to === 'vee@example.com');
check('film alerts get an unsubscribe link and header', out[0].html.includes('unsub=alerts') && out[0].text.includes('Stop film alerts') && out[0].headers['List-Unsubscribe'].includes('scope=alerts'));

/* ---- data requests ---- */
put('flieks_bank/makerFFFFFFFFFF', { bank: 'FNB', account_number: '62000001234', holder: 'Fay' });
put('flieks_transactions/tx1', { uid: 'buyerBBBBBBBBBB', amount: 49, status: 'complete' });
put('flieks_transactions/tx2', { uid: 'someoneElse', amount: 25 });
r = await admin({ action: 'export', uid: 'buyerBBBBBBBBBB' });
check('export has their purchases, transactions and email history', r.status === 200 && r.d.data.purchases.film1 && Object.keys(r.d.data.transactions).join() === 'tx1' && Object.keys(r.d.data.email_preference_history || {}).length >= 3, Object.keys(r.d.data));
r = await admin({ action: 'export', uid: 'makerFFFFFFFFFF' });
check('export hides all but the last digits of a bank account', r.d.data.bank_details.account_number === '••••1234');
put('flieks_agreements/makerFFFFFFFFFF', { ref: 'AGR-1', signed_at: 1 });
put('flieks_watch_emails/film3/e1', { email: 'fay@example.com', at: 2 });
r = await admin({ action: 'export', uid: 'makerFFFFFFFFFF' });
check('export includes their agreement, coming-soon alerts and marketing sends', r.d.data.other_records.agreements && r.d.data.other_records.coming_soon_alerts.film3 && r.d.data.other_records.marketing_emails_sent, Object.keys(r.d.data.other_records));
check('exports are logged', Object.keys(get('flieks_crm/exports') || {}).length === 3);

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
process.exit(failed ? 1 : 0);
