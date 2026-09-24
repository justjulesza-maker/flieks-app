/**
 * script-coach-start — the only door into script-extract-background.
 *
 * The extractor reads a whole screenplay with the large model, so it must not
 * be callable by anyone who finds its address. This checks the caller is a
 * signed-in filmmaker or admin, applies a monthly limit (admins exempt) and a
 * size cap, then hands the job to the background function with a shared
 * secret the browser never sees.
 *
 * POST { token, title, writers, storyBy, fileBase64, fileName, jobId } -> { ok }
 */
const crypto = require('crypto');
const ops = require('../lib/ops-core');

const LIMIT = parseInt(process.env.SCRIPT_COACH_LIMIT || '5', 10);   // per 30 days, admins exempt
const MAX_BASE64 = 5.5 * 1024 * 1024;                                  // ~4MB file; Netlify caps requests at 6MB
const DAY = 864e5;

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});
const coachSecret = () => crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':script-coach').digest('hex');

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { message: 'Bad request.' }); }

  try {
    const key = process.env.FIREBASE_API_KEY;
    if (!b.token || !key) return reply(401, { message: 'Please sign in.' });
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: b.token })
    });
    const u = ((await r.json().catch(() => ({}))).users || [])[0];
    if (!u) return reply(401, { message: 'Please sign in.' });
    const profile = await ops.dbGet(`flieks_users/${u.localId}`) || {};
    const role = profile.role;
    if (role !== 'admin' && role !== 'filmmaker') {
      return reply(403, { message: 'Script upload is for 4flieks filmmakers.' });
    }

    const title = String(b.title || '').trim().slice(0, 120);
    const jobId = String(b.jobId || '');
    const fileName = String(b.fileName || '').slice(0, 120);
    if (!title || !b.fileBase64 || !fileName) return reply(400, { message: 'Add a title and a file.' });
    if (!/^[a-z0-9-]{1,120}$/.test(jobId)) return reply(400, { message: 'Bad job id.' });
    if (!/\.(pdf|docx)$/i.test(fileName)) return reply(400, { message: 'Upload a PDF or DOCX file.' });
    if (typeof b.fileBase64 !== 'string' || b.fileBase64.length > MAX_BASE64) {
      return reply(413, { message: 'That file is too big for Script Coach (about 4MB at most).' });
    }

    if (role !== 'admin') {
      const used = await ops.dbGet(`flieks_script_coach_usage/${u.localId}`) || {};
      const since = Date.now() - 30 * DAY;
      if (Object.values(used).filter(t => t >= since).length >= LIMIT) {
        return reply(429, { message: `You've used your ${LIMIT} Script Coach uploads for this month.` });
      }
    }
    await ops.dbWrite(`flieks_script_coach_usage/${u.localId}/${jobId}`, Date.now());

    const base = process.env.URL || 'https://4flieks.com';
    const kick = await fetch(`${base}/.netlify/functions/script-extract-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-job-secret': coachSecret() },
      body: JSON.stringify({
        title, writers: String(b.writers || '').slice(0, 300), storyBy: String(b.storyBy || '').slice(0, 300),
        fileBase64: b.fileBase64, fileName, jobId
      })
    }).catch(e => ({ ok: false, status: 0 }));
    if (kick.status !== 202 && !kick.ok) return reply(502, { message: 'Could not start the extraction. Try again.' });
    return reply(200, { ok: true, jobId });
  } catch (e) {
    console.error('[script-coach-start]', e);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};
