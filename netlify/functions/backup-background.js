/**
 * backup-background — takes a full copy of the database into Netlify Blobs.
 * Started every night by flieks-backup-nightly, or by an admin pressing
 * "Back up now" in the control centre. Needs the x-job-secret header.
 * Records the result at flieks_ops/backup/last and alerts Julian if it fails.
 */
const crypto = require('crypto');
const { connectLambda, getStore } = require('@netlify/blobs');
const backup = require('../lib/backup');
const ops = require('../lib/ops-core');

const secret = () => crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':backup').digest('hex');

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  if (!process.env.FIREBASE_DB_SECRET || (event.headers || {})['x-job-secret'] !== secret()) return { statusCode: 403, body: 'no' };
  let kind = 'nightly', by = null;
  try { const b = JSON.parse(event.body || '{}'); kind = b.kind === 'manual' ? 'manual' : 'nightly'; by = b.by || null; } catch {}
  try {
    connectLambda(event);
    const store = getStore({ name: 'flieks-backups', consistency: 'strong' });
    const m = await backup.run(store, { kind, by });
    await ops.dbWrite('flieks_ops/backup/last', { at: m.at, stamp: m.stamp, kind, ok: true, parts: m.parts.length, raw: m.raw, gz: m.gz, nodes: m.nodes });
    console.log('[backup] done', m.stamp, m.parts.length, 'parts', m.raw, 'bytes');
  } catch (e) {
    console.error('[backup] failed', e);
    await ops.dbWrite('flieks_ops/backup/last', { at: Date.now(), kind, ok: false, error: String(e.message || e).slice(0, 300) }).catch(() => {});
    await ops.notify('alert', 'Database backup failed', `The ${kind} backup did not finish: ${String(e.message || e).slice(0, 300)}. The last good backup is still there. Open the control centre to try again.`).catch(() => {});
  }
  return { statusCode: 200, body: 'done' };
};
