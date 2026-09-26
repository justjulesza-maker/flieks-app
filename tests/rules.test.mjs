/**
 * Database rules tests: each one tries an attack from the September 2026
 * security audit and expects the rules to refuse it (or allow the normal use).
 *
 * Run on a computer with Java and Node:
 *   npm i --no-save firebase-tools @firebase/rules-unit-testing firebase
 *   npx firebase emulators:exec --only database --project demo-flieks "node tests/rules.test.mjs"
 */
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { ref, set, update, remove } from 'firebase/database';

const env = await initializeTestEnvironment({
  projectId: 'demo-flieks',
  database: { rules: readFileSync('database.rules.json', 'utf8'), host: '127.0.0.1', port: 9000 }
});
const STORE = 'https://firebasestorage.googleapis.com/v0/b/flieks-app.firebasestorage.app/o/';

await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.database();
  await set(ref(db, 'flieks_users'), { adm: { role: 'admin' }, fm: { role: 'filmmaker' }, fm2: { role: 'filmmaker' }, v: { role: 'viewer' } });
  await set(ref(db, 'flieks_films'), { mine: { title: 'Mine', filmmaker_uid: 'fm', status: 'review' }, theirs: { title: 'Theirs', filmmaker_uid: 'fm2', status: 'live' } });
  await set(ref(db, 'flieks_result_keys'), { key1: 'theirs' });
});

const as = uid => env.authenticatedContext(uid).database();
let failed = 0;
async function check(label, p) { try { await p; console.log('PASS ', label); } catch (e) { failed++; console.log('FAIL ', label, '—', e.message); } }

// H1: private media
await check('H1 anyone signed in cannot write a podcast episode\'s private media', assertFails(set(ref(as('v'), 'flieks_private/pod_e1'), { video_url: 'https://evil/x.mp4' })));
await check('H1 cannot pre-create private media for a film that does not exist', assertFails(set(ref(as('v'), 'flieks_private/future1'), { video_url: STORE + 'flieks_films%2Ffuture1%2Fx.mp4' })));
await check('H1 another filmmaker cannot write my film\'s private media', assertFails(set(ref(as('fm2'), 'flieks_private/mine'), { video_url: STORE + 'flieks_films%2Fmine%2Fx.mp4' })));
await check('H1 the owner can save their own upload link', assertSucceeds(set(ref(as('fm'), 'flieks_private/mine'), { video_url: STORE + 'flieks_films%2Fmine%2Ffilm.mp4?alt=media&token=t' })));
await check('H1 the owner cannot point at another film\'s file', assertFails(update(ref(as('fm'), 'flieks_private/mine'), { video_url: STORE + 'flieks_films%2Ftheirs%2Ffilm.mp4' })));
await check('C3 the owner cannot write a Bunny id (server only)', assertFails(update(ref(as('fm'), 'flieks_private/mine'), { bunny_id: 'aaaaaaaa-1111' })));

// C2 / M7: film fields
await check('C2 poster colour must be a colour', assertFails(update(ref(as('fm'), 'flieks_films/mine'), { poster_bg: '#000"><img src=x onerror=alert(1)>' })));
await check('C2 a real colour is fine', assertSucceeds(update(ref(as('fm'), 'flieks_films/mine'), { poster_bg: '#1C1512' })));
await check('C2 poster link must be our storage, no quotes', assertFails(update(ref(as('fm'), 'flieks_films/mine'), { poster_url: "https://x/p.jpg');}" })));
await check('C2 running time must be a number', assertFails(update(ref(as('fm'), 'flieks_films/mine'), { duration_mins: '<img src=x>' })));
await check('C2 titles have a length limit', assertFails(update(ref(as('fm'), 'flieks_films/mine'), { title: 'x'.repeat(200) })));
await check('C2 film ids must be safe characters', assertFails(set(ref(as('fm'), "flieks_films/a'b"), { title: 'x', filmmaker_uid: 'fm', status: 'review' })));
await check('filmmaker can still edit a normal title', assertSucceeds(update(ref(as('fm'), 'flieks_films/mine'), { title: 'My Film', synopsis: 'A story.' })));

// C2: cast
await check('C2 cast photo must be our storage, no quotes', assertFails(set(ref(as('fm'), 'flieks_cast/mine/a'), { name: 'A', photoUrl: 'x" onerror="alert(1)' })));
await check('C2 cast social links cannot be javascript:', assertFails(set(ref(as('fm'), 'flieks_cast/mine/a'), { name: 'A', instagram: 'javascript:alert(1)' })));
await check('C2 a plain handle and an https link are fine', assertSucceeds(set(ref(as('fm'), 'flieks_cast/mine/a'), { name: 'A', role: 'Lead', instagram: '@thabo_r', tiktok: 'https://tiktok.com/@a', photoUrl: '' })));
await check('C2 cast slugs must be safe characters', assertFails(set(ref(as('fm'), 'flieks_cast/mine/a"b'), { name: 'A' })));

// L4 and roles
await check('L4 a stranger cannot delete another film\'s results link', assertFails(remove(ref(as('fm'), 'flieks_result_keys/key1'))));
await check('L4 the film\'s owner can delete it', assertSucceeds(remove(ref(as('fm2'), 'flieks_result_keys/key1'))));
await check('roles: a viewer cannot make themselves admin', assertFails(update(ref(as('v'), 'flieks_users/v'), { role: 'admin' })));

await env.cleanup();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
