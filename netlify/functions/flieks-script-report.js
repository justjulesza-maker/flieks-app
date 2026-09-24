/**
 * flieks-script-report — the Script Report (4flieks Lab).
 *
 * POST { action, ... }
 *   start  { token, title, writer?, fileUrl, fileName }  filmmaker/admin: queue a report from a PDF
 *   start  { token, title, writer?, text, fileName, source }  …or from text (Word/.txt read in the
 *                                                          browser, or pasted); held server-side
 *                                                          until the reader has it, then deleted
 *   list   { token }                                      my reports, newest first
 *   get    { id }                                         a report by its link id (shareable)
 *   delete { token, id }                                  remove one of my reports (and its pitch)
 *   pitch-start { token, id, team, ask, contact, stage }  owner: (re)write the one-page pitch
 *   pitch-get   { pid, token? }                           a pitch by its own link (shareable)
 *   pitch-save  { token, pid, copy, details }             owner: save hand edits
 *
 * The screenplay is uploaded by the browser to Storage (flieks_scripts/lab_<uid>/…,
 * owner-only under the Storage rules) and only its download link comes here.
 * The reading itself happens in script-report-background, which can run for
 * up to 15 minutes. Reports live in flieks_script_reports/<id>; the id is long
 * and random, so the link is the key, like the release report.
 */
const crypto = require('crypto');
const ops = require('../lib/ops-core');

const LIMIT = parseInt(process.env.SCRIPT_REPORT_LIMIT || '5', 10);   // per 30 days, admins exempt
const BUCKET_PREFIX = 'https://firebasestorage.googleapis.com/v0/b/flieks-app.firebasestorage.app/o/';
const DAY = 864e5;

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

async function lookup(token) {
  const key = process.env.FIREBASE_API_KEY;
  if (!token || !key) return null;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token })
  });
  const u = ((await r.json().catch(() => ({}))).users || [])[0];
  if (!u) return null;
  const profile = await ops.dbGet(`flieks_users/${u.localId}`) || {};
  return { uid: u.localId, email: u.email || '', role: profile.role || 'viewer', name: profile.name || '' };
}

const newId = () => crypto.randomBytes(15).toString('base64').replace(/[+/=]/g, '').slice(0, 20);
const validId = id => typeof id === 'string' && /^[A-Za-z0-9]{12,40}$/.test(id);
const jobSecret = () => crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':script-report').digest('hex');
const pitchSecret = () => crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':pitch').digest('hex');
const STAGES = ['Idea', 'Script', 'Financing', 'Pre-production', 'Shooting', 'Post-production', 'Finished'];
const MAX_PITCH_DRAFTS = 10;
const { normalisePitch } = require('../lib/script-report-core');

function cleanDetails(d) {
  d = d && typeof d === 'object' ? d : {};
  return {
    team: String(d.team || '').trim().slice(0, 1500),
    ask: String(d.ask || '').trim().slice(0, 800),
    contact: String(d.contact || '').trim().slice(0, 160),
    stage: STAGES.includes(d.stage) ? d.stage : 'Script'
  };
}
function pitchView(pid, p, isOwner) {
  return {
    pid, status: p.status, error: p.status === 'error' ? (p.error || 'Something went wrong.') : null,
    title: p.title, writer: p.writer || null, details: p.details || {}, copy: p.copy || null,
    updated_at: p.updated_at || p.created_at, is_owner: !!isOwner, report_id: isOwner ? p.report_id : null
  };
}
async function optionalUser(token) { try { return token ? await lookup(token) : null; } catch { return null; } }

/* What anyone with the link may see. Never the owner's uid or the file link. */
function publicView(id, rec) {
  return {
    id,
    status: rec.status,
    stage: rec.stage || null,
    error: rec.status === 'error' ? (rec.error || 'Something went wrong.') : null,
    title: rec.title,
    writer: rec.writer || null,
    created_at: rec.created_at,
    finished_at: rec.finished_at || null,
    report: rec.status === 'done' ? rec.report : null
  };
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { message: 'Bad request.' }); }
  const { action } = body;

  try {
    /* ---- anyone with the link ---- */
    if (action === 'get') {
      if (!validId(body.id)) return reply(404, { message: 'Report not found.' });
      const rec = await ops.dbGet(`flieks_script_reports/${body.id}`);
      if (!rec) return reply(404, { message: 'Report not found.' });
      const view = publicView(body.id, rec);
      const who = await optionalUser(body.token);
      if (who && (who.uid === rec.owner || who.role === 'admin')) {
        view.is_owner = true;
        view.pitch_id = rec.pitch_id || null;
        view.owner_email = rec.owner_email || '';
      }
      return reply(200, view);
    }

    if (action === 'pitch-get') {
      if (!validId(body.pid)) return reply(404, { message: 'Pitch not found.' });
      const pitch = await ops.dbGet(`flieks_pitches/${body.pid}`);
      if (!pitch) return reply(404, { message: 'Pitch not found.' });
      const who = await optionalUser(body.token);
      return reply(200, pitchView(body.pid, pitch, who && (who.uid === pitch.owner || who.role === 'admin')));
    }

    const me = await lookup(body.token);
    if (!me) return reply(401, { message: 'Please sign in.' });

    /* ---- my reports ---- */
    if (action === 'list') {
      const mine = await ops.dbGet(`flieks_script_reports_by_user/${me.uid}`) || {};
      const items = Object.entries(mine).map(([id, r]) => ({ id, ...r }))
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      const since = Date.now() - 30 * DAY;
      const used = items.filter(r => (r.created_at || 0) >= since).length;
      return reply(200, { items, limit: me.role === 'admin' ? null : LIMIT, used, role: me.role });
    }

    if (action === 'delete') {
      if (!validId(body.id)) return reply(404, { message: 'Report not found.' });
      const rec = await ops.dbGet(`flieks_script_reports/${body.id}`);
      if (!rec || (rec.owner !== me.uid && me.role !== 'admin')) return reply(404, { message: 'Report not found.' });
      await ops.dbWrite(`flieks_script_reports/${body.id}`, null);
      await ops.dbWrite(`flieks_script_texts/${body.id}`, null);
      if (rec.pitch_id) await ops.dbWrite(`flieks_pitches/${rec.pitch_id}`, null);
      await ops.dbWrite(`flieks_script_reports_by_user/${rec.owner}/${body.id}`, null);
      return reply(200, { ok: true, filePath: rec.file_path || null });
    }

    /* ---- start one ---- */
    if (action === 'start') {
      if (me.role !== 'filmmaker' && me.role !== 'admin') {
        return reply(403, { message: 'Script Report is for 4flieks filmmakers. Apply at 4flieks.com/filmmaker.' });
      }
      const title = String(body.title || '').trim().slice(0, 120);
      const writer = String(body.writer || '').trim().slice(0, 120);
      const fileUrl = String(body.fileUrl || '');
      const text = typeof body.text === 'string' ? body.text : '';
      if (title.length < 1) return reply(400, { message: 'Give it a title.' });

      if (text) {
        if (text.length > 400000) return reply(413, { message: 'That text is too long. Try the first part, or a PDF.' });
        if (text.replace(/\s+/g, '').length < 400) return reply(400, { message: 'That is too short to report on. Paste the full story or treatment.' });
      } else {
        // Only a file this person uploaded to their own lab folder in our bucket.
        const ownPrefix = `${BUCKET_PREFIX}${encodeURIComponent(`flieks_scripts/lab_${me.uid}/`)}`;
        if (!fileUrl.startsWith(ownPrefix) || !/[?&]token=/.test(fileUrl)) {
          return reply(400, { message: 'Upload the file first.' });
        }
      }

      if (me.role !== 'admin') {
        const mine = await ops.dbGet(`flieks_script_reports_by_user/${me.uid}`) || {};
        const since = Date.now() - 30 * DAY;
        const used = Object.values(mine).filter(r => (r.created_at || 0) >= since).length;
        if (used >= LIMIT) {
          return reply(429, { message: `You've used your ${LIMIT} script reports for this month. More open up as the month rolls on.` });
        }
      }

      const id = newId();
      const now = Date.now();
      const filePath = text ? null : decodeURIComponent(fileUrl.slice(BUCKET_PREFIX.length).split('?')[0]);
      const source = ['docx', 'txt', 'paste'].includes(body.source) ? body.source : (text ? 'paste' : 'pdf');
      if (text) await ops.dbWrite(`flieks_script_texts/${id}`, { text, owner: me.uid, created_at: now });
      await ops.dbWrite(`flieks_script_reports/${id}`, {
        owner: me.uid, owner_email: me.email, title, writer: writer || null,
        status: 'queued', stage: 'Waiting to start…', created_at: now, source,
        file_url: text ? null : fileUrl, file_path: filePath, file_name: String(body.fileName || '').slice(0, 120)
      });
      await ops.dbWrite(`flieks_script_reports_by_user/${me.uid}/${id}`, { title, created_at: now, status: 'queued' });

      // Hand over to the background reader. It answers 202 at once.
      const base = process.env.URL || 'https://4flieks.com';
      const kick = await fetch(`${base}/.netlify/functions/script-report-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-job-secret': jobSecret() },
        body: JSON.stringify({ id })
      }).catch(e => ({ ok: false, status: 0, statusText: e.message }));
      if (!kick.ok && kick.status !== 202) {
        await ops.dbWrite(`flieks_script_reports/${id}`, { status: 'error', error: 'Could not start the reader. Try again.', finished_at: Date.now() }, 'PATCH');
        await ops.dbWrite(`flieks_script_reports_by_user/${me.uid}/${id}`, { status: 'error' }, 'PATCH');
        return reply(502, { message: 'Could not start the reader. Try again.' });
      }
      return reply(200, { ok: true, id });
    }

    /* ---- the pitch ---- */
    if (action === 'pitch-start') {
      if (!validId(body.id)) return reply(404, { message: 'Report not found.' });
      const rec = await ops.dbGet(`flieks_script_reports/${body.id}`);
      if (!rec || (rec.owner !== me.uid && me.role !== 'admin')) return reply(404, { message: 'Report not found.' });
      if (rec.status !== 'done') return reply(409, { message: 'The report is not ready yet.' });
      const pid = rec.pitch_id || newId();
      const prev = rec.pitch_id ? await ops.dbGet(`flieks_pitches/${pid}`) : null;
      const drafts = (prev && prev.drafts) || 0;
      if (drafts >= MAX_PITCH_DRAFTS && me.role !== 'admin') {
        return reply(429, { message: `That's ${MAX_PITCH_DRAFTS} drafts for this pitch. Edit the text by hand instead.` });
      }
      const now = Date.now();
      await ops.dbWrite(`flieks_pitches/${pid}`, {
        report_id: body.id, owner: rec.owner, title: rec.title, writer: rec.writer || null,
        details: cleanDetails(body), copy: (prev && prev.copy) || null,
        status: 'queued', drafts: drafts + 1, created_at: (prev && prev.created_at) || now, updated_at: now
      });
      if (!rec.pitch_id) await ops.dbWrite(`flieks_script_reports/${body.id}`, { pitch_id: pid }, 'PATCH');
      const base = process.env.URL || 'https://4flieks.com';
      const kick = await fetch(`${base}/.netlify/functions/pitch-writer-background`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-job-secret': pitchSecret() },
        body: JSON.stringify({ pid })
      }).catch(() => ({ ok: false, status: 0 }));
      if (!kick.ok && kick.status !== 202) {
        await ops.dbWrite(`flieks_pitches/${pid}`, { status: 'error', error: 'Could not start the writer. Try again.' }, 'PATCH');
        return reply(502, { message: 'Could not start the writer. Try again.' });
      }
      return reply(200, { ok: true, pid });
    }

    if (action === 'pitch-save') {
      if (!validId(body.pid)) return reply(404, { message: 'Pitch not found.' });
      const pitch = await ops.dbGet(`flieks_pitches/${body.pid}`);
      if (!pitch || (pitch.owner !== me.uid && me.role !== 'admin')) return reply(404, { message: 'Pitch not found.' });
      const fields = { updated_at: Date.now() };
      if (body.copy) fields.copy = normalisePitch(body.copy);
      if (body.details) fields.details = cleanDetails(body.details);
      await ops.dbWrite(`flieks_pitches/${body.pid}`, fields, 'PATCH');
      return reply(200, { ok: true });
    }

    return reply(400, { message: 'Unknown action.' });
  } catch (e) {
    console.error('[script-report]', e);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};

module.exports.jobSecret = jobSecret;
