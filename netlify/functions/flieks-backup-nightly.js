/**
 * flieks-backup-nightly — scheduled in netlify.toml for 00:30 UTC (02:30 in
 * Johannesburg). Starts the backup job, which has 15 minutes to run.
 */
const crypto = require('crypto');

exports.handler = async () => {
  const secret = crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':backup').digest('hex');
  const base = process.env.URL || 'https://4flieks.com';
  const kick = await fetch(`${base}/.netlify/functions/backup-background`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-job-secret': secret },
    body: JSON.stringify({ kind: 'nightly' })
  }).catch(e => ({ ok: false, status: 0, statusText: e.message }));
  const ok = kick.ok || kick.status === 202;
  if (!ok) console.error('[backup-nightly] did not start', kick.status, kick.statusText);
  return { statusCode: ok ? 200 : 500, body: ok ? 'started' : 'failed' };
};
