/**
 * Lab scheduler: the planning engine (lab-schedule.js), the script breakdown
 * (schedule-core + schedule-breakdown-background) and the new flieks-budget
 * actions, against the September 2026 audit, with an in-memory database.
 *   node tests/schedule.test.mjs
 * Needs pdf-parse and mammoth installed (npm install), as on Netlify.
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const T = require('./budget-mocks.cjs');
const S = require('../lab-schedule.js');
const sc = require('../netlify/lib/schedule-core.js');
const core = require('../netlify/lib/budget-core.js');
const fake = require('./schedule-fake-ai.cjs');
const { api, addUser, get, put } = T;

let failed = 0, passed = 0;
function check(label, cond, extra) { if (cond) { passed++; console.log('PASS ', label); } else { failed++; console.log('FAIL ', label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); } }
const wait = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 1. the engine ---------- */
function prod() {
  const p = { scenes: [], shootDays: [], contacts: [], locations: [], sched: { start: '2027-03-01', off: [0], pace: 4.25, maxLocs: 2 } };
  p.locations.push({ id: 'oflat', name: 'Flat', town: 'Johannesburg' }, { id: 'ostreet', name: 'Street', town: 'Johannesburg' }, { id: 'obeach', name: 'Beach', town: 'Durban' });
  p.contacts.push({ id: 'cann', kind: 'cast', name: 'Ann', character: 'ZOE', unavail: [] }, { id: 'cbob', kind: 'cast', name: 'Bob', character: 'JAMES', unavail: [] },
    { id: 'ccrew', kind: 'crew', name: 'Cam', role: 'DOP' });
  const add = (no, loc, dn, pages, cast, effort = 2) => p.scenes.push({ id: 'sc' + no, no: String(no), ie: 'INT', dn, set: loc, pages, castIds: cast, locationId: loc, effort, dayId: '' });
  for (let i = 1; i <= 12; i++) add(i, 'oflat', 'DAY', '2', i % 2 ? ['cann', 'cbob'] : ['cbob']);
  for (let i = 13; i <= 18; i++) add(i, 'ostreet', 'NIGHT', '1 4/8', ['cbob'], 3);
  for (let i = 19; i <= 22; i++) add(i, 'obeach', 'DAY', '2', ['cann'], 2);
  return p;
}
{
  const p = prod(); const r = S.plan(p);
  check('plan: every scene gets a day', p.scenes.every(s => s.dayId) && r.days === p.shootDays.length, r);
  check('plan: dates start on the start date, skip Sundays', p.shootDays[0].date === '2027-03-01' && p.shootDays.every(d => S.weekday(d.date) !== 0));
  check('plan: no day overloaded', p.shootDays.every(d => S.stats(p, d).load <= 1.25), p.shootDays.map(d => S.stats(p, d).load));
  check('plan: Johannesburg before Durban', p.shootDays.findIndex(d => S.stats(p, d).locs.includes('obeach')) > p.shootDays.findIndex(d => S.stats(p, d).locs.includes('oflat')));
  const jhb = p.shootDays.filter(d => !S.stats(p, d).locs.includes('obeach'));
  check('plan: days before nights within an area', jhb.findIndex(d => S.stats(p, d).night) > jhb.findIndex(d => !S.stats(p, d).night));
  check('plan: call-sheet cast ticked from scenes', p.shootDays.every(d => S.stats(p, d).cast.every(id => d.cast[id] && d.cast[id].on)));
  check('plan: crew never put on cast', p.shootDays.every(d => !d.cast.ccrew));
  check('plan: scenes ordered within each day', p.shootDays.every(d => S.scenesOf(p, d.id).every((s, i) => s.pos === i + 1)));

  // actor can't work: clash shown, re-plan avoids it, locked day untouched
  const d1 = p.shootDays[0];
  p.contacts[0].unavail = [d1.date];
  const clash = S.conflicts(p).filter(c => c.kind === 'actor');
  check('availability: clash reported with the actor and scenes', clash.length >= 1 && /Ann \(ZOE\) can't work/.test(clash[0].text), clash);
  const lock = p.shootDays[2]; lock.locked = true; const lockState = JSON.stringify({ d: lock.date, s: S.scenesOf(p, lock.id).map(s => s.id) });
  S.plan(p);
  check('re-plan: no actor clashes left', S.conflicts(p).filter(c => c.kind === 'actor').length === 0, S.conflicts(p));
  const lk = p.shootDays.find(d => d.locked);
  check('re-plan: locked day keeps its date and scenes', lk && JSON.stringify({ d: lk.date, s: S.scenesOf(p, lk.id).map(s => s.id) }) === lockState);
  check('re-plan: published day keeps its link', (() => { const q = prod(); S.plan(q); q.shootDays[0].token = 'a'.repeat(32); S.plan(q); return q.shootDays.some(d => d.token === 'a'.repeat(32)); })());

  // moving by hand
  const a = p.shootDays.find(d => !d.locked), b = p.shootDays.filter(d => !d.locked)[1];
  const s0 = S.scenesOf(p, a.id)[0];
  S.moveScene(p, s0.id, b.id, S.scenesOf(p, b.id)[0].id);
  check('move: scene lands first in the other day', S.scenesOf(p, b.id)[0] === s0 && s0.dayId === b.id);
  check('move: both days renumbered', [a, b].every(d => S.scenesOf(p, d.id).every((s, i) => s.pos === i + 1)));
  S.moveScene(p, s0.id, '', null);
  check('move: to unscheduled', !s0.dayId);
  const before = p.shootDays.map(d => d.date);
  const i = p.shootDays.indexOf(b), nb = p.shootDays[i + 1];
  if (!nb.locked && !b.locked) { S.swapDay(p, b.id, 1); check('swap: dates stay in calendar order, content swaps', p.shootDays.map(d => d.date).join() === before.join() && p.shootDays[i + 1] === b); }
  const moved = S.shiftFrom(p, p.shootDays[p.shootDays.length - 2].id, 2);
  check('push back: later unlocked days move 2 days', moved >= 1);
  const nd = S.insertDay(p, p.shootDays[0].id);
  check('insert: new day after, on a free working date', nd.date && !p.shootDays.some(d => d !== nd && d.date === nd.date) && S.weekday(nd.date) !== 0);
  const n0 = p.scenes.filter(s => !s.dayId).length, victim = p.shootDays.find(d => !d.locked && S.scenesOf(p, d.id).length);
  const k = S.scenesOf(p, victim.id).length; S.deleteDay(p, victim.id);
  check('delete day: its scenes become unscheduled', p.scenes.filter(s => !s.dayId).length === n0 + k);
  S.plan(p, { mode: 'unscheduled' });
  check('fit unscheduled: nothing left over, other days untouched', p.scenes.every(s => s.dayId) && p.shootDays.find(d => d.locked));
  check('swap refuses a locked day', S.swapDay(p, p.shootDays.find(d => d.locked).id, 1) === 'locked' || p.shootDays[p.shootDays.length - 1].locked);
  p.shootDays[1].date = p.shootDays[0].date;
  check('clash: two days on one date', S.conflicts(p).some(c => c.kind === 'date'));
  p.shootDays[1].date = '2027-03-07';
  check('clash: day on a day off', S.conflicts(p).some(c => c.kind === 'off'));
  check('pages maths', S.eighths('1 3/8') === 11 && S.pagesText(11) === '1 3/8' && S.pagesText(8) === '1' && S.pagesText(3) === '3/8');
}

/* ---------- 2. reading scripts ---------- */
check('heading: plain', JSON.stringify(sc.headingOf('INT. KITCHEN - NIGHT')) === JSON.stringify({ no: '', heading: 'INT. KITCHEN - NIGHT' }));
check('heading: margin numbers', sc.headingOf('12 EXT. ROAD - DAY 12').no === '12');
check('heading: numbered with INT later', sc.headingOf("10. FLOYD & MELODY'S HOUSE. INT. - LATE MORNING").no === '10');
check('heading: not dialogue or action', !sc.headingOf('                    JAMES') && !sc.headingOf('He walks into the Interior of the bar.') && !sc.headingOf('CUT TO:'));
check('heading parse: night, set', JSON.stringify(sc.parseHeading('EXT. SPORTS GROUND - NIGHT')) === JSON.stringify({ ie: 'EXT', dn: 'NIGHT', set: 'SPORTS GROUND' }));
check('heading parse: continuous keeps time', sc.parseHeading('INT. OFFICE - CONTINUOUS', 'NIGHT').dn === 'NIGHT');
check('heading parse: I/E', sc.parseHeading('I/E. CAR - DAY').ie === 'INT/EXT');
const AI_BAD = JSON.stringify([{ n: '1', set: '<b>x</b>'.repeat(30), loc: 'A', cast: ['<img src=x onerror=alert(1)>', 'JAMES (V.O.)', 'JAMES'], props: Array(20).fill('p'), notes: [1, {}], effort: 9, ie: 'OUT', dn: 'NOON' }]);
const merged = sc.mergeAi([{ no: '1', heading: 'INT. A - DAY', ie: 'INT', dn: 'DAY', set: 'A', page: 1, eighths: 8, text: '' }], sc.parseJsonArray('blah ' + AI_BAD + ' blah'));
const cleaned = sc.cleanBreakdown({ scenes: merged });
const c0 = cleaned.scenes[0];
check('AI answer: lengths capped, enums enforced', c0.set.length <= 80 && c0.ie === 'INT' && c0.dn === 'DAY' && c0.effort === 2 && c0.props.length <= 8);
check('AI answer: V.O. folded into the character, deduped', c0.cast.filter(x => x === 'JAMES').length === 1 && c0.cast.length === 2, c0.cast);
check('AI answer: non-strings in notes dropped or stringified safely', c0.notes.every(n => typeof n === 'string'));
check('AI answer: garbage is an empty list', sc.parseJsonArray('no json here').length === 0 && sc.parseJsonArray('[{bad').length === 0);
check('text pages: 54 lines a page', sc.pagesFromText(Array(120).fill('x').join('\n')).length === 3);

const MC = '/tmp/claude-0/mc/script.pdf', RD = '/tmp/claude-0/rd/script.pdf';
let pdfOk = false; try { require.resolve('pdf-parse'); pdfOk = true; } catch { }
if (pdfOk && existsSync(MC) && existsSync(RD)) {
  for (const [f, scenes, pages] of [[MC, 34, 52], [RD, 76, 53]]) {
    const r = await sc.pagesFromPdf(readFileSync(f)); const s = sc.splitScenes(r.pages);
    const tot = s.reduce((a, x) => a + x.eighths, 0) / 8;
    check(`real script ${f.split('/')[3]}: ${scenes} scenes found`, s.length === scenes, s.length);
    check(`real script ${f.split('/')[3]}: pages add up`, Math.abs(tot - pages) <= 1.5, tot);
  }
} else console.log('SKIP real-PDF checks (pdf-parse or the sample scripts not here)');

/* ---------- 3. flieks-budget: new fields, versions, breakdown jobs ---------- */
addUser('tS', 'schedSSSSSSSSSS');
addUser('tO', 'otherOOOOOOOOOO');
addUser('tU2', 'unverVVVVVVVVVV', { verified: false });
addUser('tUL', 'unlimLLLLLLLLLL', { unlimited: true });
const base = { title: 'Test', type: 'feature', sections: [], contacts: [], locations: [], scenes: [], shootDays: [], costs: [], days: { shoot: 3 } };
const cr = await api({ action: 'create', token: 'tS', production: base });
const pid = cr.d.id;
check('create production', cr.status === 200 && pid);
const evilProd = {
  ...base,
  contacts: [{ id: 'cann', kind: 'cast', name: 'Ann', character: 'ZOE', unavail: ['2027-03-01', '2027-03-01', 'nope', '<x>', '2027-02-30x'] }, { id: 'ccrew', kind: 'crew', name: 'C', role: 'DOP', unavail: ['2027-01-01'] }],
  locations: [{ id: 'oflat', name: 'Flat' }],
  shootDays: [{ id: 'dday1', date: '2027-03-01', locked: 'yes', cast: { cann: { on: true, auto: 1 } } }, { id: 'dday2', date: '2027-03-02', locked: true }],
  scenes: [{ id: 'sone', no: '1', dayId: 'dday1', castIds: ['cann', 'ccrew', 'ghost', '../x'], locationId: '../../flieks_films', effort: 99, pos: -5, props: 'x'.repeat(5000), sday: 'Day 1' }],
  sched: { start: '2027-03-01', off: [0, 0, 6, 9, 'x'], pace: 99, maxLocs: 0, evil: '<script>' }
};
const sv = await api({ action: 'save', token: 'tS', id: pid, production: evilProd });
const st = get(`flieks_budgets/schedSSSSSSSSSS/${pid}`);
check('save: cleaned scheduler fields', sv.status === 200 && st.scenes[0].castIds.join() === 'cann' && st.scenes[0].locationId === '' && st.scenes[0].effort === 4 && st.scenes[0].pos === 0 && st.scenes[0].props.length === 600, st.scenes[0]);
check('save: unavailable dates valid, unique, cast only', JSON.stringify(st.contacts[0].unavail) === '["2027-03-01"]' && st.contacts[1].unavail === undefined);
check('save: locked only when true', st.shootDays[0].locked === false && st.shootDays[1].locked === true);
check('save: settings clamped, unknown keys dropped', JSON.stringify(st.sched) === JSON.stringify({ start: '2027-03-01', off: [0, 6], pace: 12, maxLocs: 1 }), st.sched);
check('save: cast auto flag is boolean', st.shootDays[0].cast.cann.auto === false);

// versions
for (let i = 0; i < 7; i++) await api({ action: 'save', token: 'tS', id: pid, production: { ...evilProd, title: 'v' + i }, checkpoint: 'Before re-plan ' + i });
await api({ action: 'save', token: 'tS', id: pid, production: { ...evilProd, title: 'no checkpoint' } });
const vs = await api({ action: 'versions', token: 'tS', id: pid });
check('versions: last 5 kept, newest first', vs.status === 200 && vs.d.items.length === 5 && vs.d.items[0].label === 'Before re-plan 6' && vs.d.items[0].at > vs.d.items[4].at, vs.d);
const v1 = await api({ action: 'version', token: 'tS', id: pid, at: vs.d.items[0].at });
check('version: holds the production before that save', v1.status === 200 && v1.d.production.title === 'v5', v1.d.production && v1.d.production.title);
check('version: other members can\'t read it', (await api({ action: 'version', token: 'tO', id: pid, at: vs.d.items[0].at })).status === 404 && (await api({ action: 'versions', token: 'tO', id: pid })).d.items.length === 0);
check('version: bad ids refused', (await api({ action: 'version', token: 'tS', id: pid, at: '../../x' })).status === 400 && (await api({ action: 'versions', token: 'tS', id: '../x' })).status === 400);
check('checkpoint label is capped text', (await api({ action: 'save', token: 'tS', id: pid, production: evilProd, checkpoint: '<b>' + 'x'.repeat(200) })).status === 200
  && (await api({ action: 'versions', token: 'tS', id: pid })).d.items[0].label.length <= 60);
await api({ action: 'delete', token: 'tS', id: (await api({ action: 'create', token: 'tS', production: base })).d.id });

// breakdown jobs
const big = 'INT. A - DAY\n' + 'x\n'.repeat(300);
check('script-start: signed out refused', (await api({ action: 'script-start', text: big })).status === 401);
check('script-start: unverified email refused', (await api({ action: 'script-start', token: 'tU2', text: big })).status === 403);
check('script-start: wrong file type refused', (await api({ action: 'script-start', token: 'tS', fileName: 'x.exe', fileBase64: 'AAAA' })).status === 400);
check('script-start: too-short paste refused', (await api({ action: 'script-start', token: 'tS', text: 'INT. A' })).status === 400);
check('script-start: huge paste refused', (await api({ action: 'script-start', token: 'tS', text: 'x'.repeat(600001) })).status === 413);
check('script-start: non-base64 refused', (await api({ action: 'script-start', token: 'tS', fileName: 'a.pdf', fileBase64: '<script>' })).status === 400);

T.setAnthropicFn(b => /break down screenplays/.test(b.system || '') ? fake(b, { 1: { set: '<img src=x onerror=alert(1)>', cast: ['ZOE', 'ZOE (V.O.)'] } }) : '[]');
const script = Array.from({ length: 6 }, (_, i) => `${i + 1} ${i % 2 ? 'EXT' : 'INT'}. PLACE ${i} - ${i > 3 ? 'NIGHT' : 'DAY'} ${i + 1}\n\nAction.\n\n                    ZOE\n          Hello.\n\n` + 'More action.\n'.repeat(20)).join('\n');
const s1 = await api({ action: 'script-start', token: 'tS', text: script, title: 'My film' });
check('script-start: job made', s1.status === 200 && /^j[a-f0-9]{20}$/.test(s1.d.jobId), s1.d);
const call0 = T.lastSchedule();
check('background started with the job secret', call0 && call0.opts.headers['x-job-secret'] && call0.opts.headers['x-job-secret'].length === 64);
const bad = await T.scheduleBg().handler({ httpMethod: 'POST', body: call0.opts.body, headers: { 'x-job-secret': 'x'.repeat(64) } });
check('background: refused without the secret', bad.statusCode === 403);
check('script-status: someone else\'s job is not found', (await api({ action: 'script-status', token: 'tO', jobId: s1.d.jobId })).status === 404);
let r = null;
for (let i = 0; i < 40; i++) { await wait(50); r = await api({ action: 'script-status', token: 'tS', jobId: s1.d.jobId }); if (r.d.status === 'done' || r.d.status === 'error') break; }
check('breakdown done: 6 scenes', r && r.d.status === 'done' && r.d.breakdown.scenes.length === 6, r && r.d);
check('breakdown: night from the heading, pages counted', r.d.breakdown.scenes[5].dn === 'NIGHT' && r.d.breakdown.scenes.every(s => s.eighths >= 1));
check('breakdown: AI text kept as text, cast deduped', r.d.breakdown.scenes[0].set.includes('<img') && r.d.breakdown.scenes[0].cast.join() === 'ZOE');
check('breakdown: read once, then gone', (await api({ action: 'script-status', token: 'tS', jobId: s1.d.jobId })).status === 404);
const again = await T.scheduleBg().handler({ httpMethod: 'POST', body: call0.opts.body, headers: { 'x-job-secret': call0.opts.headers['x-job-secret'] } });
check('background: a job runs only once', again.statusCode === 409);
// the quote importer can't read a breakdown job and vice versa
const s2 = await api({ action: 'script-start', token: 'tS', text: script });
check('import-status refuses a breakdown job', (await api({ action: 'import-status', token: 'tS', jobId: s2.d.jobId })).status === 404);
await wait(400);
// monthly limit, counted in the ledger
for (let i = 0; i < 3; i++) await api({ action: 'script-start', token: 'tS', text: script });
const over = await api({ action: 'script-start', token: 'tS', text: script });
check('limit: 5 breakdowns a month', over.status === 429, over);
check('limit: unlimited members are not limited', (await api({ action: 'script-start', token: 'tUL', text: script })).status === 200);
const lst = await api({ action: 'list', token: 'tS' });
check('list: shows breakdowns used', lst.d.breakdowns.used === 5 && lst.d.breakdowns.limit === 5, lst.d.breakdowns);
check('limit: deleting productions does not give breakdowns back', await (async () => { const c = await api({ action: 'create', token: 'tS', production: base }); await api({ action: 'delete', token: 'tS', id: c.d.id }); return (await api({ action: 'script-start', token: 'tS', text: script })).status === 429; })());
await wait(400);
// no headings → a clear error
const s3 = await api({ action: 'script-start', token: 'tUL', text: 'Just some prose.\n'.repeat(40) });
for (let i = 0; i < 40; i++) { await wait(50); r = await api({ action: 'script-status', token: 'tUL', jobId: s3.d.jobId }); if (r.d.status === 'done' || r.d.status === 'error') break; }
check('breakdown: no headings gives a clear error', r.d.status === 'error' && /No scene headings/.test(r.d.error), r.d);
check('rules: new nodes are server-only', /"flieks_budget_versions":\s*\{ ".read": false, ".write": false \}/.test(readFileSync(new URL('../database.rules.json', import.meta.url), 'utf8')));
check('call sheet: scenes in board order', (() => {
  const p = core.cleanProduction({ ...base, shootDays: [{ id: 'dd1', date: '2027-03-01' }], scenes: [{ id: 'sa', no: '1', dayId: 'dd1', pos: 2 }, { id: 'sb', no: '2', dayId: 'dd1', pos: 1 }] }, null);
  return core.sheetFrom(p, 'dd1').scenes.map(s => s.no).join() === '2,1';
})());

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
