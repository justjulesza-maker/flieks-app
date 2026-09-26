/**
 * backup — a full copy of the Realtime Database, kept in Netlify Blobs.
 *
 * Every top-level node is exported and gzipped as its own part. A node too big
 * for one part (a function reply tops out near 6 MB) is split by its children
 * across several parts. The manifest is written last, so a backup without one
 * never finished and is not offered for download.
 *
 *   <stamp>/manifest.json   { stamp, at, kind, by, parts: [{ name, key, partial, raw, gz }], ... }
 *   <stamp>/p001.json.gz    { key, partial, data }
 *
 * Kept: every backup from the last 35 days, and never fewer than the 7 newest.
 * Restore: download from the control centre (one JSON file, the whole database)
 * and import it in the Firebase console, at the root or one node at a time.
 */
const zlib = require('zlib');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip), gunzip = promisify(zlib.gunzip);

const DB = () => (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const auth = () => `auth=${process.env.FIREBASE_DB_SECRET}`;
const PART_MAX = 3.5 * 1024 * 1024;       // gzipped; base64 of this still fits a function reply
const KEEP_DAYS = 35, KEEP_MIN = 7;

async function dbJson(path, query = '', fetchImpl = fetch) {
  const url = `${DB()}/${path}.json?${auth()}${query ? '&' + query : ''}`;
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`read ${path || '/'}: ${r.status}`);
  return r.json();
}
const encKey = k => k.split('/').map(encodeURIComponent).join('/');
const stampOf = t => new Date(t).toISOString().replace(/[:.]/g, '-');   // sorts by time

const toAB = buf => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);

/** Take a full backup. Returns the manifest. */
async function run(store, { kind = 'nightly', by = null, fetchImpl = fetch, now = Date.now() } = {}) {
  const stamp = stampOf(now);
  const parts = [];
  let n = 0;
  const store1 = async (key, partial, data, raw, gz) => {
    const name = `p${String(++n).padStart(3, '0')}.json.gz`;
    await store.set(`${stamp}/${name}`, toAB(gz));
    parts.push({ name, key, partial, raw: raw.length, gz: gz.length });
  };
  // Store a set of children, halving it until each part is small enough.
  // How well data compresses varies a lot, so the size is measured, not guessed.
  const putChildren = async (key, entries) => {
    const data = Object.fromEntries(entries);
    const raw = JSON.stringify({ key, partial: true, data });
    const gz = await gzip(raw, { level: 9 });
    if (gz.length > PART_MAX && entries.length > 1) {
      const mid = Math.ceil(entries.length / 2);
      await putChildren(key, entries.slice(0, mid));
      await putChildren(key, entries.slice(mid));
    } else await store1(key, true, data, raw, gz);
  };

  const top = Object.keys(await dbJson('', 'shallow=true', fetchImpl) || {}).sort();
  for (const key of top) {
    const data = await dbJson(encKey(key), 'format=export', fetchImpl);
    const raw = JSON.stringify({ key, partial: false, data });
    const gz = await gzip(raw, { level: 9 });
    if (gz.length <= PART_MAX || data === null || typeof data !== 'object') await store1(key, false, data, raw, gz);
    else await putChildren(key, Object.entries(data).sort(([a], [b]) => a < b ? -1 : 1));
  }

  const manifest = {
    stamp, at: now, kind, by, nodes: top.length, parts,
    raw: parts.reduce((a, p) => a + p.raw, 0), gz: parts.reduce((a, p) => a + p.gz, 0), ok: true
  };
  await store.setJSON(`${stamp}/manifest.json`, manifest);
  await prune(store, now);
  return manifest;
}

/** Finished backups, newest first. */
async function list(store) {
  const { blobs } = await store.list();
  const stamps = [...new Set(blobs.filter(b => b.key.endsWith('/manifest.json')).map(b => b.key.split('/')[0]))];
  const out = [];
  for (const s of stamps) { const m = await store.get(`${s}/manifest.json`, { type: 'json' }); if (m) out.push(m); }
  return out.sort((a, b) => b.at - a.at);
}

/** Delete old backups (and pieces of ones that never finished). */
async function prune(store, now = Date.now()) {
  const { blobs } = await store.list();
  const byStamp = {};
  for (const b of blobs) (byStamp[b.key.split('/')[0]] = byStamp[b.key.split('/')[0]] || []).push(b.key);
  const finished = Object.keys(byStamp).filter(s => byStamp[s].includes(`${s}/manifest.json`)).sort().reverse();
  const keep = new Set(finished.slice(0, KEEP_MIN));
  const cutoff = stampOf(now - KEEP_DAYS * 864e5);
  let removed = 0;
  for (const [s, keys] of Object.entries(byStamp)) {
    const done = keys.includes(`${s}/manifest.json`);
    const stale = done ? (s < cutoff && !keep.has(s)) : (s < stampOf(now - 864e5));   // unfinished: gone after a day
    if (!stale) continue;
    for (const k of keys) await store.delete(k);
    removed++;
  }
  return removed;
}

/** One part, gzipped, for the browser to download. */
async function part(store, stamp, name) {
  if (!/^[0-9TZ-]{20,40}$/.test(stamp) || !/^p\d{3,4}\.json\.gz$/.test(name)) return null;
  const ab = await store.get(`${stamp}/${name}`, { type: 'arrayBuffer' });
  return ab ? Buffer.from(ab) : null;
}

/** Put the parts back together into the whole database (used by tests and restores). */
async function assemble(buffers) {
  const out = {};
  for (const b of buffers) {
    const { key, partial, data } = JSON.parse((await gunzip(b)).toString());
    if (partial) out[key] = Object.assign(out[key] || {}, data); else out[key] = data;
  }
  return out;
}

module.exports = { run, list, prune, part, assemble, stampOf, PART_MAX };
