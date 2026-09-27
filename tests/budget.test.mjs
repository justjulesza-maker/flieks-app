/**
 * Budget & call sheets: attacks from the September 2026 security audit,
 * run against the real functions with an in-memory database.
 *   node tests/budget.test.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const T = require('./budget-mocks.cjs');
const { api, addUser, get, put } = T;

let failed = 0, passed = 0;
function check(label, cond, extra) { if (cond) { passed++; console.log('PASS ', label); } else { failed++; console.log('FAIL ', label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); } }

addUser('tA', 'userAAAAAAAAAAA');                                   // verified viewer
addUser('tB', 'userBBBBBBBBBBB');                                   // another verified viewer
addUser('tU', 'userUUUUUUUUUUU', { verified: false });              // unverified viewer
addUser('tF', 'userFFFFFFFFFFF', { verified: false, role: 'filmmaker' });
addUser('tX', 'userXXXXXXXXXXX', { unlimited: true });

const XSS = `</script><script>window.__x=1</script><img src=x onerror="window.__x=2">'"`;
const prod = (over = {}) => Object.assign({
  title: 'Test', type: 'short', days: { prep: 1, shoot: 2, post: 1 }, runtime: 12,
  sections: [{ id: 's1', name: 'Camera', group: 'btl', lines: [{ id: 'l1', desc: 'DOP', qty: 1, units: 0, unit: 'Day', link: 'shoot', rate: 4000, role: 'crew' }] }],
  contacts: [{ id: 'c1', kind: 'crew', name: 'Ally', role: 'DOP', dept: 'Camera', phone: '082 000 0000', email: 'ally@x.co' },
             { id: 'c2', kind: 'cast', name: 'Bokang', character: 'Nomalizo', phone: '083 111 2222' }],
  locations: [{ id: 'o1', name: 'Studio', address: '3 Fisant Ave', town: 'Fourways', hospital: 'Netcare Fourways' }],
  shootDays: [{ id: 'd1', date: '2026-10-06', locationId: 'o1', crewCall: '07:00', shootCall: '08:00', lunch: '13:00', wrap: '18:00',
                cast: { c2: { on: true, pickup: '06:00', hmu: '06:30', set: '08:00' } }, crewOff: {}, deptCalls: [], running: [] },
              { id: 'd2', date: '2026-10-07', locationId: 'o1', cast: {}, crewOff: {}, deptCalls: [], running: [] }],
  scenes: [{ id: 'sc1', no: '1', ie: 'INT', dn: 'DAY', set: 'Kitchen', desc: 'Breakfast', pages: '1 3/8', cast: 'Nomalizo', dayId: 'd1' }],
  costs: []
}, over);

/* ---------- H4 / sign-in ---------- */
for (const action of ['list', 'get', 'create', 'save', 'delete', 'publish', 'weather', 'import-start', 'import-status', 'acks']) {
  const r = await api({ action, id: 'p1', production: prod() });
  check(`H4 ${action} without sign-in is refused`, r.status === 401, r);
}
check('H4 a forged token is refused', (await api({ action: 'list', token: 'forged' })).status === 401);
check('unverified viewer cannot create', (await api({ action: 'create', token: 'tU', production: prod() })).status === 403);
check('unverified filmmaker can create (filmmakers always can)', (await api({ action: 'create', token: 'tF', production: prod() })).status === 200);

/* ---------- create / isolation ---------- */
const c = await api({ action: 'create', token: 'tA', production: prod() });
check('verified member can create', c.status === 200 && /^p[a-f0-9]{14}$/.test(c.d.id), c);
const pid = c.d.id;
check('server makes the id (client id ignored)', !('id' in c.d.production));
check('another member cannot read it', (await api({ action: 'get', token: 'tB', id: pid })).status === 404);
check('another member cannot save over it', (await api({ action: 'save', token: 'tB', id: pid, production: prod({ title: 'pwned' }) })).status === 404);
check('another member cannot delete it', (await api({ action: 'delete', token: 'tB', id: pid })).status === 404 && get(`flieks_budgets/userAAAAAAAAAAA/${pid}`));
check('another member cannot publish its days', (await api({ action: 'publish', token: 'tB', id: pid, dayId: 'd1' })).status === 404);
check('list shows only my own', (await api({ action: 'list', token: 'tB' })).d.items.length === 0);

/* ---------- M1: ids in paths ---------- */
for (const bad of ['../flieks_users', 'a/b', 'A$b', 'x.y', '', 'p'.repeat(60), { a: 1 }]) {
  const r1 = await api({ action: 'get', token: 'tA', id: bad });
  const r2 = await api({ action: 'publish', token: 'tA', id: pid, dayId: bad });
  const r3 = await api({ action: 'sheet', t: bad });
  const r4 = await api({ action: 'import-status', token: 'tA', jobId: bad });
  check(`M1 id ${JSON.stringify(bad).slice(0, 20)} rejected everywhere`, r1.status === 400 && r2.status === 400 && r3.status === 404 && r4.status === 400, [r1.status, r2.status, r3.status, r4.status]);
}

/* ---------- C2 / M7: every field cleaned on save ---------- */
const dirty = prod({
  title: XSS, type: 'evil', company: XSS, evil: 'x', runtime: 'abc', contPct: 1e9,
  sections: [{ id: 's1', name: XSS, group: 'root', open: 'yes', lines: [{ id: 'l1', desc: XSS, qty: '5', units: '<b>', unit: 'Parsec', link: 'moon', rate: -50, role: 'admin', notes: XSS }] }],
  contacts: [{ id: 'c1', kind: 'admin', name: XSS, role: XSS, dept: XSS, phone: 'javascript:alert(1)', email: '"><img src=x>@a.co' },
             { id: 'c1', kind: 'crew', name: 'duplicate id' }, { id: '../x', name: 'bad id' }],
  shootDays: [{ id: 'd1', date: '2026-10-06"><x', locationId: '../o', crewCall: '07:00"', notes: XSS, token: 'aaaaaaaaaaaaaaaaaaaaaaaa',
                weather: { summary: XSS, high: '"><x', sunrise: '"><img>' }, cast: { 'c2': { on: 'true', pickup: 'x' }, 'a.b': { on: true }, '$x': { on: true } },
                crewOff: { c1: 'yes', 'c/2': true }, deptCalls: [], running: [{ id: 'r1', time: XSS, item: XSS, who: XSS }] }],
  scenes: [{ id: 'sc1', ie: '<x>', dn: 'NOON', pages: '1"><x', dayId: 'nope' }]
});
const sv = await api({ action: 'save', token: 'tA', id: pid, production: dirty });
check('save of hostile data succeeds but is cleaned', sv.status === 200, sv);
const st = get(`flieks_budgets/userAAAAAAAAAAA/${pid}`);
check('C2 unknown fields dropped', !('evil' in st));
check('M7 type/group/unit/link/role limited to known values', st.type === 'other' && st.sections[0].group === 'btl' && st.sections[0].lines[0].unit === 'Day' && st.sections[0].lines[0].link === null && st.sections[0].lines[0].role === null);
check('M7 numbers are numbers and in range', st.runtime === 0 && st.contPct === 100 && st.sections[0].lines[0].qty === 5 && st.sections[0].lines[0].rate === 0 && st.sections[0].lines[0].units === 0);
check('M7 booleans are real booleans', st.sections[0].open === false && st.shootDays[0].cast.c2.on === false);
check('C2 phone that is not a phone number is dropped (no javascript: tel links)', st.contacts[0].phone === '');
check('C2 email with quotes is dropped', st.contacts[0].email === '');
check('M7 contact kind limited', st.contacts[0].kind === 'crew');
check('M1 duplicate and unsafe item ids dropped', st.contacts.length === 1);
check('M1 unsafe map keys dropped', Object.keys(st.shootDays[0].cast).join() === 'c2' && Object.keys(st.shootDays[0].crewOff).length === 0);
check('M7 dates, times and page counts must match their format', st.shootDays[0].date === '' && st.shootDays[0].crewCall === '' && st.shootDays[0].weather.sunrise === '' && st.shootDays[0].weather.high === '' && st.scenes[0].pages === '');
check('M7 scene enums limited, dangling day id cleared', st.scenes[0].ie === 'INT' && st.scenes[0].dn === 'DAY' && st.scenes[0].dayId === '');
check('the browser cannot set a share link id', st.shootDays[0].token === '');
check('text length capped', st.shootDays[0].notes.length <= 2000 && st.title.length <= 120);

/* ---------- caps ---------- */
const many = prod({ contacts: Array.from({ length: 1000 }, (_, i) => ({ id: 'c' + i, kind: 'crew', name: 'x'.repeat(500) })) });
await api({ action: 'save', token: 'tA', id: pid, production: many });
const st2 = get(`flieks_budgets/userAAAAAAAAAAA/${pid}`);
check('lists capped (300 contacts), names capped (80)', st2.contacts.length === 300 && st2.contacts[0].name.length === 80);

let madeB = 0;
await Promise.all(Array.from({ length: 60 }, () => api({ action: 'create', token: 'tB', production: prod() }).then(r => { if (r.status === 200) madeB++; })));
check('race: 60 creates at once stop at the 50-production cap', madeB === 50, madeB);

/* ---------- publish / public sheet ---------- */
await api({ action: 'save', token: 'tA', id: pid, production: prod() });
put('flieks_budgets/userUUUUUUUUUUU/pu1234', prod());
check('unverified member cannot publish even their own', (await api({ action: 'publish', token: 'tU', id: 'pu1234', dayId: 'd1' })).status === 403);
const pub = await api({ action: 'publish', token: 'tA', id: pid, dayId: 'd1' });
check('publish gives a 32-char random link id', pub.status === 200 && /^[a-f0-9]{32}$/.test(pub.d.token), pub);
const tok = pub.d.token;
const sh = await api({ action: 'sheet', t: tok });
const shJson = JSON.stringify(sh.d);
check('public sheet loads without sign-in', sh.status === 200 && sh.d.sheet.title === 'Test');
check('public sheet never shows owner uid, emails, rates or costs', !shJson.includes('userAAAA') && !shJson.includes('ally@x.co') && !shJson.includes('4000') && !shJson.includes('"rate"'));
check('republish keeps the same link', (await api({ action: 'publish', token: 'tA', id: pid, dayId: 'd1' })).d.token === tok);
await api({ action: 'save', token: 'tA', id: pid, production: prod({ shootDays: prod().shootDays.map(d => ({ ...d, hidePhones: true })) }) });
await api({ action: 'publish', token: 'tA', id: pid, dayId: 'd1' });
check('hide phone numbers really removes them from the public sheet', !JSON.stringify((await api({ action: 'sheet', t: tok })).d).includes('082 000'));
check('save keeps the server-made link id', get(`flieks_budgets/userAAAAAAAAAAA/${pid}`).shootDays[0].token === tok);

// someone else's sheet at a day's stored token is never overwritten
put(`flieks_callsheets/${'b'.repeat(32)}`, { owner: 'userBBBBBBBBBBB', sheet: { title: 'B' } });
put(`flieks_budgets/userAAAAAAAAAAA/${pid}/shootDays/1/token`, 'b'.repeat(32));
const pub2 = await api({ action: 'publish', token: 'tA', id: pid, dayId: 'd2' });
check('publishing never writes over another member\'s sheet', pub2.d.token !== 'b'.repeat(32) && get(`flieks_callsheets/${'b'.repeat(32)}`).sheet.title === 'B', pub2);

/* ---------- acks (public, rate limited) ---------- */
check('ack needs a name', (await api({ action: 'ack', t: tok, name: 'x' })).status === 400);
check('ack on an unknown sheet is 404', (await api({ action: 'ack', t: 'c'.repeat(32), name: 'Ally' })).status === 404);
let acked = 0;
for (let i = 0; i < 25; i++) if ((await api({ action: 'ack', t: tok, name: 'Crew ' + i }, { 'x-nf-client-connection-ip': '1.2.3.4' })).status === 200) acked++;
check('L2 one visitor gets 20 confirmations an hour', acked === 20, acked);
const ackList = await api({ action: 'acks', token: 'tA', id: pid, dayId: 'd1' });
check('owner sees the confirmations', ackList.d.items.length === 20);
check('another member cannot read them', (await api({ action: 'acks', token: 'tB', id: pid, dayId: 'd1' })).status === 404);
T.setFailCounters(true);
check('L8 limits fail closed when the database errors', (await api({ action: 'ack', t: tok, name: 'Someone' }, { 'x-nf-client-connection-ip': '9.9.9.9' })).status === 429);
T.setFailCounters(false);

/* ---------- take down ---------- */
await api({ action: 'save', token: 'tA', id: pid, production: prod({ shootDays: [prod().shootDays[1]] }) });
check('removing a day takes its public sheet down', !get(`flieks_callsheets/${tok}`) && (await api({ action: 'sheet', t: tok })).status === 404);
const pub3 = await api({ action: 'publish', token: 'tA', id: pid, dayId: 'd2' });
await api({ action: 'unpublish', token: 'tA', id: pid, dayId: 'd2' });
check('unpublish takes the link down', (await api({ action: 'sheet', t: pub3.d.token })).status === 404);
const pub4 = await api({ action: 'publish', token: 'tA', id: pid, dayId: 'd2' });
await api({ action: 'delete', token: 'tA', id: pid });
check('deleting a production takes its links down', (await api({ action: 'sheet', t: pub4.d.token })).status === 404 && !get(`flieks_budgets/userAAAAAAAAAAA/${pid}`));

/* ---------- AI import (H4) ---------- */
const pdf = Buffer.from('%PDF-1.4 test').toString('base64');
check('unverified member cannot import', (await api({ action: 'import-start', token: 'tU', fileBase64: pdf, fileName: 'q.pdf' })).status === 403);
check('only PDFs', (await api({ action: 'import-start', token: 'tA', fileBase64: pdf, fileName: 'q.exe' })).status === 400);
check('size capped', (await api({ action: 'import-start', token: 'tA', fileBase64: 'A'.repeat(6 * 1024 * 1024), fileName: 'q.pdf' })).status === 413);
let started = 0; const jobs = [];
await Promise.all(Array.from({ length: 12 }, () => api({ action: 'import-start', token: 'tA', fileBase64: pdf, fileName: 'q.pdf' }).then(r => { if (r.status === 200) { started++; jobs.push(r.d.jobId); } })));
check('H4 race: 12 imports at once, only 5 get through', started === 5, started);
check('H4 usage kept in an append-only ledger', Object.keys(get('flieks_lab_usage/userAAAAAAAAAAA/budget_imports') || {}).length === 5);
check('H4 job ids are made on the server', jobs.every(j => /^j[a-f0-9]{20}$/.test(j)));
let x = 0; for (let i = 0; i < 7; i++) if ((await api({ action: 'import-start', token: 'tX', fileBase64: pdf, fileName: 'q.pdf' })).status === 200) x++;
check('Lab unlimited partners have no import limit', x === 7);

// background job: must be started by flieks-budget, runs once, output cleaned
const bg = T.lastBackground();
const bgBody = JSON.parse(bg.opts.body);
check('M4 background call carries a hashed secret, not the database secret', bg.opts.headers['x-job-secret'] && bg.opts.headers['x-job-secret'] !== 'test-secret' && !JSON.stringify(bgBody).includes('test-secret'));
const noSecret = await T.background.handler({ headers: {}, body: bg.opts.body });
check('background refuses calls without the secret', noSecret.statusCode === 403);
T.setAnthropic(JSON.stringify([{ category: '<b>Cam</b>', name: XSS, qty: '2', days: 'x', rate: '1500' }, { name: '' }, 'junk']));
await T.background.handler({ headers: bg.opts.headers, body: bg.opts.body });
const again = await T.background.handler({ headers: bg.opts.headers, body: bg.opts.body });
check('each job runs once', again.statusCode === 409);
const stS = await api({ action: 'import-status', token: 'tX', jobId: bgBody.jobId });
check('AI output cleaned to numbers and short text', stS.status === 200 && stS.d.items.length === 1 && stS.d.items[0].qty === 2 && stS.d.items[0].days === 1 && stS.d.items[0].rate === 1500, stS.d);
check('import results are read once, then deleted', (await api({ action: 'import-status', token: 'tX', jobId: bgBody.jobId })).status === 404);
check('someone else\'s job is not theirs to read', (await api({ action: 'import-status', token: 'tB', jobId: jobs[0] })).status === 404);

/* ---------- weather ---------- */
const w = await api({ action: 'weather', token: 'tA', place: 'Fourways', date: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10) });
check('weather is looked up server-side and cleaned', w.status === 200 && w.d.ok && w.d.weather.sunrise === '05:44' && w.d.weather.high === 28, w.d);
check('weather needs a real date', (await api({ action: 'weather', token: 'tA', place: 'Fourways', date: '2026-10-06"' })).status === 400);

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
process.exit(failed ? 1 : 0);
