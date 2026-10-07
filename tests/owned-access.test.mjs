/**
 * Buyers keep films that come off sale (distribution agreement 8.4):
 *  - the Bunny "reset" can't wipe the streaming copy of a film that has sold
 *    (filmmakers never; admins only while an original upload remains)
 *  - the library finds owned films that are no longer live, and play never
 *    borrows another film's details.
 *   node tests/owned-access.test.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);

let failed = 0, passed = 0;
function check(label, cond, extra) { if (cond) { passed++; console.log('PASS ', label); } else { failed++; console.log('FAIL ', label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); } }

/* ---------- flieks-bunny reset, against an in-memory database ---------- */
process.env.FIREBASE_API_KEY = 'k'; process.env.FIREBASE_DB_SECRET = 's';
process.env.BUNNY_LIBRARY_ID = 'lib'; process.env.BUNNY_API_KEY = 'bk';
const db = {};
const segs = p => p.split('/').filter(Boolean);
const get = p => { let o = db; for (const k of segs(p)) { if (o == null) return null; o = o[k]; } return o ?? null; };
const patch = (p, v) => { let o = db; for (const k of segs(p)) o = o[k] ??= {}; for (const [k, x] of Object.entries(v)) { if (x === null) delete o[k]; else o[k] = x; } };
const users = { tAdmin: 'admin1', tMaker: 'maker1' };
const bunnyDeletes = [];
const https = require('https');
https.request = (url, opts = {}, cb) => {
  url = String(url); let body = '';
  const r = { on() { return r; }, write(b) { body += b; }, setTimeout() {}, end() {
    let status = 200, out = 'null';
    if (url.includes('identitytoolkit')) { const uid = users[JSON.parse(body).idToken]; out = JSON.stringify(uid ? { users: [{ localId: uid }] } : {}); }
    else if (url.includes('video.bunnycdn.com')) { if (opts.method === 'DELETE') bunnyDeletes.push(url); out = '{}'; }
    else { const p = decodeURIComponent(url.split('.com/')[1].split('.json')[0]); if (opts.method === 'PATCH') patch(p, JSON.parse(body)); else out = JSON.stringify(get(p)); }
    const res = { statusCode: status, on(ev, f) { if (ev === 'data') f(out); if (ev === 'end') f(); return res; }, resume() {} };
    cb(res);
  } };
  return r;
};
const bunnyFn = require('../netlify/functions/flieks-bunny.js');
const reset = async (token, filmId) => { const r = await bunnyFn.handler({ httpMethod: 'POST', body: JSON.stringify({ token, filmId, action: 'reset' }) }); return { status: r.statusCode, d: JSON.parse(r.body || '{}') }; };

const setFilm = (id, { sales = 0, original = true } = {}) => {
  db.flieks_films = { ...(db.flieks_films || {}), [id]: { title: id, filmmaker_uid: 'maker1', status: 'draft' } };
  db.flieks_private = { ...(db.flieks_private || {}), [id]: { bunny_id: 'b-' + id, bunny_ready: true, bunny_owned: true, ...(original ? { video_url: 'https://firebasestorage.googleapis.com/x' } : {}) } };
  db.flieks_stats = { ...(db.flieks_stats || {}), [id]: { totals: { sales } } };
  db.flieks_users = { admin1: { role: 'admin' }, maker1: { role: 'filmmaker' } };
};

setFilm('unsold');
let r = await reset('tMaker', 'unsold');
check('filmmaker can still reset a film nobody has bought', r.status === 200 && bunnyDeletes.length === 1, r);

setFilm('sold', { sales: 3 });
r = await reset('tMaker', 'sold');
check('filmmaker cannot reset a film people bought', r.status === 403 && bunnyDeletes.length === 1 && get('flieks_private/sold/bunny_id') === 'b-sold', r);

setFilm('soldonly', { sales: 1, original: false });
r = await reset('tAdmin', 'soldonly');
check('admin cannot wipe the only copy of a sold film', r.status === 409 && bunnyDeletes.length === 1 && get('flieks_private/soldonly/bunny_id') === 'b-soldonly', r);

r = await reset('tAdmin', 'sold');
check('admin can reset a sold film while the original upload remains', r.status === 200 && bunnyDeletes.length === 2 && get('flieks_private/sold/video_url'), r);

/* ---------- website: library and play (functions taken from index.html) ---------- */
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const grab = (start, end = '\n}\n') => { const i = html.indexOf(start); if (i < 0) throw new Error('missing ' + start); return html.slice(i, html.indexOf(end, i) + end.length); };
const code = [
  'let allFilms = [], soonFilms = [], userPurchases = {}, currentFilm = null; const DB_PREFIX = "flieks_";',
  'const cleanFilm = f => f;',
  html.slice(html.indexOf('const findFilm = '), html.indexOf('let ownedOffSale = [];') + 'let ownedOffSale = [];'.length),
  grab('const hasAccess = '.replace(/ $/, ' '), ';\n'),
  grab('async function loadOwnedOffSale() {'),
  grab('async function playFilm(filmId) {', '\n  if (f.free || !purchase)').replace(/\n  if \(f\.free \|\| !purchase\)$/, ''),
  '  return f; }'
].join('\n');
const FILMS = { live1: { title: 'Live One', status: 'live' }, gone: { title: 'Withdrawn', status: 'draft' }, review: { title: 'Replaced file', status: 'review' }, rentgone: { title: 'Rented then withdrawn', status: 'draft' }, oldrent: { title: 'Expired rental', status: 'draft' } };
const snacks = [];
const ctx = vm.createContext({
  db: { ref: p => ({ once: async () => ({ val: () => FILMS[p.split('/').pop()] ? { ...FILMS[p.split('/').pop()] } : null }) }) },
  showSnack: m => snacks.push(m), console, Date
});
vm.runInContext(code, ctx);
vm.runInContext(`allFilms = [{ id: 'live1', title: 'Live One', status: 'live' }];
  userPurchases = { live1: { type: 'own' }, gone: { type: 'own' }, review: { type: 'own' }, rentgone: { type: 'rent', expires_at: Date.now() + 36e5 },
    oldrent: { type: 'rent', expires_at: Date.now() - 1 }, missing: { type: 'own' }, pod_x: { type: 'own' } };`, ctx);
await vm.runInContext('loadOwnedOffSale()', ctx);
const off = vm.runInContext('ownedOffSale.map(f => f.id).sort().join()', ctx);
check('owned withdrawn + in-review films and an active rental are found', off === 'gone,rentgone,review', off);
check('expired rental of a withdrawn film is not', !off.includes('oldrent'));
check('withdrawn films are marked off sale', vm.runInContext('ownedOffSale.every(f => f.off_sale)', ctx));
check('findFilm finds a withdrawn film', vm.runInContext('findFilm("gone") && findFilm("gone").title', ctx) === 'Withdrawn');

vm.runInContext('currentFilm = { id: "live1", title: "Live One" }', ctx);
const played = await vm.runInContext('playFilm("gone")', ctx);
check('playing a withdrawn film uses its own details, not the open page', played && played.title === 'Withdrawn', played);
const none = await vm.runInContext('playFilm("missing")', ctx);
check('a film that no longer exists says so instead of borrowing another', none === undefined && snacks.length === 1, snacks);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
