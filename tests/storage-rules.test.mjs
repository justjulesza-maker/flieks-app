/**
 * Storage rules: a film's video can't be deleted or overwritten from the site
 * (buyers keep watching it after it comes off sale); posters still can.
 *
 * Run on a computer with Java and Node:
 *   npm i --no-save firebase-tools @firebase/rules-unit-testing firebase
 *   cp storage-rules.txt storage.rules
 *   echo '{"storage":{"rules":"storage.rules"},"emulators":{"storage":{"port":9199},"ui":{"enabled":false}}}' > firebase.emulator.json
 *   npx firebase emulators:exec --config firebase.emulator.json --only storage --project demo-flieks "node tests/storage-rules.test.mjs"
 */
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { ref, uploadBytes, deleteObject, getMetadata } from 'firebase/storage';
const env = await initializeTestEnvironment({ projectId: 'demo-flieks', storage: { rules: readFileSync('storage.rules', 'utf8'), host: '127.0.0.1', port: 9199 } });
let fail = 0; const check = async (l, p) => { try { await p; console.log('PASS', l); } catch (e) { fail++; console.log('FAIL', l, e.message); } };
const fm = env.authenticatedContext('fm').storage();
const other = env.authenticatedContext('x').storage();
const bytes = new Uint8Array([1, 2, 3]);
const vid = ref(fm, 'flieks_films/f1/film-abc.mp4'), pos = ref(fm, 'flieks_films/f1/poster-abc.jpg');
await check('filmmaker uploads a film', assertSucceeds(uploadBytes(vid, bytes, { contentType: 'video/mp4', customMetadata: { owner: 'fm' } })));
await check('filmmaker uploads a poster', assertSucceeds(uploadBytes(pos, bytes, { contentType: 'image/jpeg', customMetadata: { owner: 'fm' } })));
await check('filmmaker can still read own film', assertSucceeds(getMetadata(vid)));
await check('filmmaker CANNOT delete the film video', assertFails(deleteObject(vid)));
await check('filmmaker CANNOT overwrite the film video', assertFails(uploadBytes(vid, bytes, { contentType: 'video/mp4', customMetadata: { owner: 'fm' } })));
await check('filmmaker CANNOT overwrite video with an image type', assertFails(uploadBytes(vid, bytes, { contentType: 'image/jpeg', customMetadata: { owner: 'fm' } })));
await check('replacing = new file name still works', assertSucceeds(uploadBytes(ref(fm, 'flieks_films/f1/film-new.mp4'), bytes, { contentType: 'video/mp4', customMetadata: { owner: 'fm' } })));
await check('filmmaker can replace own poster', assertSucceeds(uploadBytes(pos, bytes, { contentType: 'image/jpeg', customMetadata: { owner: 'fm' } })));
await check('filmmaker can delete own poster', assertSucceeds(deleteObject(pos)));
await check('someone else cannot delete the video', assertFails(deleteObject(ref(other, 'flieks_films/f1/film-abc.mp4'))));
await env.cleanup(); console.log(fail ? `${fail} FAILED` : 'ALL PASSED'); process.exit(fail ? 1 : 0);
