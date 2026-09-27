/**
 * Opportunities board: attacks from the September 2026 security audit, plus
 * the casting-scam cases, run against the real function with an in-memory database.
 *   node tests/board.test.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const T = require('./budget-mocks.cjs');
const { boardApi: api, addUser, get, put, emails } = T;

let failed = 0, passed = 0;
function check(label, cond, extra) { if (cond) { passed++; console.log('PASS ', label); } else { failed++; console.log('FAIL ', label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); } }

addUser('tP', 'posterPPPPPPPPP');                                   // verified member who posts
addUser('tQ', 'posterQQQQQQQQQ');                                   // another poster
addUser('tA', 'actorAAAAAAAAAA');                                   // verified applicant
addUser('tU', 'unverUUUUUUUUUU', { verified: false });
addUser('tM', 'adminMMMMMMMMMM', { role: 'admin' });
put('flieks_talent/actorAAAAAAAAAA', { name: 'Bokang', email: 'bokang@x.co', suggest: false, bio: 'Actor from Soweto', disciplines: ['Actor'], languages: ['isiZulu'], photo_url: 'https://firebasestorage.googleapis.com/v0/b/x/o/p.jpg' });

const soon = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
const XSS = `</script><script>window.__x=1</script><img src=x onerror="window.__x=2">'"`;
const post = (over = {}) => Object.assign({
  kind: 'casting', title: 'The Nothing Mirror: cast', company: 'Nguniverse', format: 'Short',
  synopsis: 'A detective short set in Johannesburg, shooting over three days in October.', city: 'Johannesburg', country: 'South Africa',
  closes: soon, pay_type: 'paid', pay_note: 'R1,500 a day', releases_on_4flieks: true, no_fees: true, questions: ['Free 6–8 Oct?'],
  roles: [{ id: 'r1', name: 'Oscar Phiri', type: 'lead', age_min: 25, age_max: 35, languages: ['isiZulu', 'English'], rate: 1500, rate_unit: 'day' },
          { id: 'r2', name: 'Young Oscar', type: 'supporting', minors: true, age_min: 10, age_max: 12 }]
}, over);

/* ---------- sign-in ---------- */
for (const action of ['mine', 'save', 'apply', 'apps', 'move', 'note', 'message', 'close', 'delete', 'budgets', 'from-budget', 'admin-list', 'decide']) {
  const r = await api({ action, id: 'b00000000000000', post: post() });
  check(`H4 ${action} without sign-in is refused`, r.status === 401, r);
}
check('unverified member cannot post', (await api({ action: 'save', token: 'tU', post: post() })).status === 403);

/* ---------- posting and approval ---------- */
check('must confirm no fees', (await api({ action: 'save', token: 'tP', post: post({ no_fees: false }) })).status === 400);
check('closing date in the past refused', (await api({ action: 'save', token: 'tP', post: post({ closes: '2020-01-01' }) })).status === 400);
check('paid work needs a rate or note', (await api({ action: 'save', token: 'tP', post: post({ pay_note: '', roles: [{ id: 'r1', name: 'X' }] }) })).status === 400);
check('under-18 role with nudity refused', (await api({ action: 'save', token: 'tP', post: post({ roles: [{ id: 'r1', name: 'Kid', minors: true, nudity: true }] }) })).status === 400);
const s1 = await api({ action: 'save', token: 'tP', post: post() });
check('member post is saved as pending, not live', s1.status === 200 && s1.d.status === 'pending' && /^b[a-f0-9]{14}$/.test(s1.d.id), s1);
const pid = s1.d.id;
check('the team is emailed to approve it', emails.some(m => /to approve/.test(m.subject)));
check('pending post is not on the public board', !(await api({ action: 'list' })).d.items.some(p => p.id === pid));
check('pending post is not visible to strangers', (await api({ action: 'get', id: pid })).status === 404 && (await api({ action: 'get', token: 'tA', id: pid })).status === 404);
check('owner can see their pending post', (await api({ action: 'get', token: 'tP', id: pid })).d.post.status === 'pending');
check('nobody can apply to a pending post', (await api({ action: 'apply', token: 'tA', id: pid, roleId: 'r1', note: 'x'.repeat(30) })).status === 410);
check('only admins approve', (await api({ action: 'decide', token: 'tP', id: pid, approve: true })).status === 403);
await api({ action: 'decide', token: 'tM', id: pid, approve: true });
const pub = await api({ action: 'get', id: pid });
check('approved post is public', pub.status === 200 && pub.d.post.status === 'live');
check('public post never shows the owner uid or email', !JSON.stringify(pub.d).includes('posterPPPP') && !JSON.stringify(pub.d).includes('@test.dev'));
check('public list never shows flags, owner or email', !JSON.stringify((await api({ action: 'list' })).d).match(/owner|@test\.dev|flags/));

/* ---------- scam words ---------- */
const scam = await api({ action: 'save', token: 'tQ', post: post({ title: 'Movie roles available now', pay_note: 'Registration fee of R350 to audition, WhatsApp only', roles: [{ id: 'r1', name: 'Lead', description: 'Send bikini photos and your bank details' }] }) });
check('scam wording is flagged for the team', scam.status === 200 && scam.d.flags.length >= 3, scam.d);
check('flagged post is held (pending)', scam.d.status === 'pending');

/* ---------- editing always goes back for checking ---------- */
const ed = await api({ action: 'save', token: 'tP', id: pid, post: post({ synopsis: 'Changed after approval: now we want a registration fee, sorry for any confusion.' }) });
check('an edit after approval goes back to pending', ed.d.status === 'pending' && !(await api({ action: 'list' })).d.items.some(p => p.id === pid));
check('another member cannot edit it', (await api({ action: 'save', token: 'tQ', id: pid, post: post({ title: 'pwned post title' }) })).status === 404);
check('another member cannot close or delete it', (await api({ action: 'close', token: 'tQ', id: pid })).status === 404 && (await api({ action: 'delete', token: 'tQ', id: pid })).status === 404);
await api({ action: 'save', token: 'tP', id: pid, post: post() });
await api({ action: 'decide', token: 'tM', id: pid, approve: true });

/* ---------- C2 / M7: cleaned fields ---------- */
const dirty = await api({ action: 'save', token: 'tQ', post: post({ title: XSS + '\nSubject: injected', kind: 'evil', format: '<b>', pay_type: 'free-money', questions: [XSS, 'b', 'c', 'd', 'e'],
  roles: [{ id: 'r1', name: XSS, type: 'god', discipline: 'Hacker', age_min: '-5', age_max: 900, languages: 'a,b,c,d,e,f,g,h,i,j', rate: '-10', minors: 'yes', nudity: 1, description: XSS },
          { id: 'r1', name: 'duplicate' }, { id: '../x', name: 'bad id' }], prod_id: '../../flieks_users', owner: 'posterPPPPPPPPP', status: 'live', app_count: 999 }) });
const dp = get(`flieks_board_posts/${dirty.d.id}`);
check('fields cleaned: enums limited', dp.kind === 'casting' && dp.format === 'Other' && dp.pay_type === 'unpaid' && dp.roles[0].type === 'other' && dp.roles[0].discipline === '');
check('single-line fields have no line breaks (no email header tricks)', !/[\r\n]/.test(dp.title));
check('numbers clamped, booleans real', dp.roles[0].age_min === 1 && dp.roles[0].age_max === 99 && dp.roles[0].rate === null && dp.roles[0].minors === false && dp.roles[0].nudity === false);
check('lists capped (3 questions, 8 languages), bad and duplicate role ids dropped', dp.questions.length === 3 && dp.roles[0].languages.length === 8 && dp.roles.length === 1);
check('owner, status and counts come from the server, not the browser', dp.owner === 'posterQQQQQQQQQ' && dp.status === 'pending' && dp.app_count === 0);
check('a budget link must be one of my own budgets', dp.prod_id === '');

/* ---------- M1: ids in paths ---------- */
for (const bad of ['../flieks_users', 'b123', 'B00000000000000', { a: 1 }, 'b0000000000000g']) {
  const r1 = await api({ action: 'get', id: bad }), r2 = await api({ action: 'apps', token: 'tP', id: bad }), r3 = await api({ action: 'report', id: bad, reason: 'bad bad' });
  check(`M1 post id ${JSON.stringify(bad).slice(0, 18)} rejected`, r1.status === 404 && r2.status === 400 && r3.status === 404, [r1.status, r2.status, r3.status]);
}
check('M1 bad role id rejected', (await api({ action: 'apply', token: 'tA', id: pid, roleId: '../x' })).status === 400);
check('M1 bad app id rejected', (await api({ action: 'move', token: 'tP', id: pid, appId: '../../x', folder: 'hire' })).status === 400);
check('M1 unknown folder rejected', (await api({ action: 'move', token: 'tP', id: pid, appId: 'a' + '0'.repeat(20), folder: 'root' })).status === 400);
check('M1 budget id checked', (await api({ action: 'from-budget', token: 'tP', prodId: '../flieks_users' })).status === 400);

/* ---------- applying ---------- */
check('unverified member cannot apply', (await api({ action: 'apply', token: 'tU', id: pid, roleId: 'r1', note: 'x'.repeat(30) })).status === 403);
check('poster cannot apply to their own post', (await api({ action: 'apply', token: 'tP', id: pid, roleId: 'r1', note: 'x'.repeat(30) })).status === 400);
check('under-18 role needs guardian consent', (await api({ action: 'apply', token: 'tA', id: pid, roleId: 'r2', note: 'x'.repeat(30) })).status === 400);
const ap = await api({ action: 'apply', token: 'tA', id: pid, roleId: 'r1', note: XSS, answers: [XSS, 'extra answer beyond the questions'], reel: 'javascript:alert(1)' });
check('member with a profile can apply', ap.status === 200 && /^a[a-f0-9]{20}$/.test(ap.d.appId), ap);
check('applying twice for one role is refused', (await api({ action: 'apply', token: 'tA', id: pid, roleId: 'r1', note: 'again' })).status === 409);
const stored = get(`flieks_board_apps/${pid}/${ap.d.appId}`);
check('application cleaned: answers capped to the questions, javascript: link dropped', stored.answers.length === 1 && stored.reel === '');
check('the poster gets one "new applications" email a day', emails.filter(m => /New applications/.test(m.subject)).length === 1);
const g = await api({ action: 'apply', token: 'tA', id: pid, roleId: 'r2', note: 'For my son', guardian: { name: 'Mrs Dlamini', consent: true } });
check('guardian can apply for an under-18 role', g.status === 200);
let n = 0; addUser('tS', 'spammerSSSSSSSS');
const many = Array.from({ length: 20 }, (_, i) => ({ id: 'q' + i, name: 'Extra ' + i, type: 'extra' }));
for (const t of ['Spam target one', 'Spam target two']) {
  const s = await api({ action: 'save', token: 'tM', post: post({ title: t, roles: many }) });
  for (const r of many) if ((await api({ action: 'apply', token: 'tS', id: s.d.id, roleId: r.id, note: 'x'.repeat(30) })).status === 200) n++;
}
check('L2 applications limited to 30 a day', n === 30, n);
check('no talent profile needs a real note', (await api({ action: 'apply', token: 'tQ', id: pid, roleId: 'r1', note: 'hi' })).status === 400);

/* ---------- application manager ---------- */
const apps = await api({ action: 'apps', token: 'tP', id: pid });
const appsJson = JSON.stringify(apps.d);
check('owner sees applications with the talent profile', apps.status === 200 && apps.d.apps.length === 2 && apps.d.apps.some(a => a.profile && a.profile.bio === 'Actor from Soweto'));
check('owner never sees the applicant\'s email or uid', !appsJson.includes('@test.dev') && !appsJson.includes('bokang@x.co') && !appsJson.includes('actorAAAA'));
check('another member cannot see the applications', (await api({ action: 'apps', token: 'tQ', id: pid })).status === 404);
check('another member cannot move, note or message', (await api({ action: 'move', token: 'tQ', id: pid, appId: ap.d.appId, folder: 'no' })).status === 404
  && (await api({ action: 'note', token: 'tQ', id: pid, appId: ap.d.appId, note: 'x' })).status === 404
  && (await api({ action: 'message', token: 'tQ', id: pid, appId: ap.d.appId, message: 'hello there you' })).status === 404);
const before = emails.length;
await api({ action: 'move', token: 'tP', id: pid, appId: ap.d.appId, folder: 'no' });
check('"No" never notifies the applicant', emails.length === before);
const mine1 = await api({ action: 'mine', token: 'tA' });
check('applicant never sees shortlist or no', mine1.d.apps.every(x => ['applied', 'closed', 'hired'].includes(x.status)));
const msg = await api({ action: 'message', token: 'tP', id: pid, appId: ap.d.appId, message: 'Please send a self-tape of scene 3 by Friday.' });
const mail = emails[emails.length - 1];
check('message goes to the applicant with replies to the poster; neither address shown on the site', msg.status === 200 && mail.to === 'actorAAAAAAAAAA@test.dev' && mail.replyTo === 'posterPPPPPPPPP@test.dev');

/* ---------- hire → budget ---------- */
T.put('flieks_budgets/posterPPPPPPPPP/pmine1', { title: 'Mirror budget', sections: [], contacts: [], shootDays: [] });
T.put('flieks_budget_index/posterPPPPPPPPP/pmine1', { title: 'Mirror budget' });
await api({ action: 'save', token: 'tP', id: pid, post: post({ prod_id: 'pmine1' }) });
await api({ action: 'decide', token: 'tM', id: pid, approve: true });
const hire = await api({ action: 'move', token: 'tP', id: pid, appId: ap.d.appId, folder: 'hire' });
const bud = get('flieks_budgets/posterPPPPPPPPP/pmine1');
check('hiring adds them to the linked budget\'s cast', hire.d.added_to_budget && bud.contacts.some(c => c.kind === 'cast' && c.character === 'Oscar Phiri'));
check('hired applicant is emailed once, and sees "hired"', emails.filter(m => /You got it/.test(m.subject)).length === 1 && (await api({ action: 'mine', token: 'tA' })).d.apps.some(x => x.status === 'hired'));
check('from-budget only reads my own budgets', (await api({ action: 'from-budget', token: 'tQ', prodId: 'pmine1' })).status === 404);

/* ---------- reports ---------- */
check('report needs a reason', (await api({ action: 'report', id: pid, reason: 'x' })).status === 400);
for (const ip of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) await api({ action: 'report', id: pid, reason: 'asks for money' }, { 'x-nf-client-connection-ip': ip });
check('three reports take it off the board until the team looks', !(await api({ action: 'list' })).d.items.some(p => p.id === pid) && (await api({ action: 'apply', token: 'tQ', id: pid, roleId: 'r1', note: 'x'.repeat(30) })).status === 410);
let rep = 0; for (let i = 0; i < 8; i++) if ((await api({ action: 'report', id: pid, reason: 'spam spam' }, { 'x-nf-client-connection-ip': '9.9.9.9' })).status === 200) rep++;
check('L2 reports limited per visitor', rep === 5, rep);
T.setFailCounters(true);
check('L8 limits fail closed when the database errors', (await api({ action: 'report', id: pid, reason: 'another one' }, { 'x-nf-client-connection-ip': '7.7.7.7' })).status === 429);
T.setFailCounters(false);

/* ---------- limits ---------- */
let open = 0; addUser('tO', 'openOOOOOOOOOOO');
await Promise.all(Array.from({ length: 14 }, (_, i) => api({ action: 'save', token: 'tO', post: post({ title: 'Parallel post ' + i }) }).then(r => { if (r.status === 200) open++; })));
check('race: 14 posts at once stop at 10 open posts', open === 10, open);

/* ---------- delete ---------- */
await api({ action: 'delete', token: 'tP', id: pid });
check('deleting a post removes its applications everywhere', !get(`flieks_board_posts/${pid}`) && !get(`flieks_board_apps/${pid}`) && !get(`flieks_board_my_apps/actorAAAAAAAAAA/${ap.d.appId}`));

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
process.exit(failed ? 1 : 0);
