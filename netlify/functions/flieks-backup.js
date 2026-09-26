/**
 * flieks-backup — database backups, for admins in the control centre.
 *
 * POST { token, action }
 *   list                         finished backups, newest first, and how the last run went
 *   run                          back up now (at most once every 10 minutes)
 *   part { stamp, name }         one gzipped part, base64, for the browser to put together
 */
const crypto = require('crypto');
const { connectLambda, getStore } = require('@netlify/blobs');
const backup = require('../lib/backup');
const ops = require('../lib/ops-core');

const reply = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { message: 'Bad request.' }); }
  try {
    const admin = await ops.verifyAdmin(b.token);
    if (!admin) return reply(403, { message: 'Admin only.' });
    connectLambda(event);
    const store = getStore({ name: 'flieks-backups', consistency: 'strong' });

    if (b.action === 'list') {
      const [items, last] = await Promise.all([backup.list(store), ops.dbGet('flieks_ops/backup/last')]);
      return reply(200, { backups: items.map(m => ({ stamp: m.stamp, at: m.at, kind: m.kind, by: m.by, nodes: m.nodes, raw: m.raw, gz: m.gz, parts: m.parts.map(p => p.name) })), last });
    }

    if (b.action === 'run') {
      if ((await ops.dbIncrement(`flieks_ops/locks/backup_${Math.floor(Date.now() / 600e3)}`)) > 1) {
        return reply(429, { message: 'A backup was started in the last few minutes. It will show here when it finishes.' });
      }
      const secret = crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':backup').digest('hex');
      const base = process.env.URL || 'https://4flieks.com';
      const kick = await fetch(`${base}/.netlify/functions/backup-background`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-job-secret': secret },
        body: JSON.stringify({ kind: 'manual', by: admin.email || admin.localId })
      }).catch(e => ({ ok: false, status: 0 }));
      if (!kick.ok && kick.status !== 202) return reply(502, { message: 'Could not start the backup. Try again.' });
      return reply(200, { ok: true });
    }

    if (b.action === 'part') {
      const buf = await backup.part(store, String(b.stamp || ''), String(b.name || ''));
      if (!buf) return reply(404, { message: 'That part of the backup is not there.' });
      return reply(200, { data: buf.toString('base64') });
    }

    return reply(400, { message: 'Unknown action.' });
  } catch (e) {
    console.error('[backup]', e);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};
