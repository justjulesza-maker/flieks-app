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
 *   funding-include { token, pid, keys }                owner: which found funds show on the pitch
 *   funding-start { token, pid, regions }               owner: search the web for funding open now
 *                                                          (regions: za, africa, europe, intl)
 *   match-start { token, id }                             owner: suggest opted-in actors for the roles
 *   connect     { token, id, talentUid, character, message }  owner: email a suggested actor
 *                                                          (their address is never shown; replies
 *                                                          come straight to the filmmaker)
 *
 * Open to any 4flieks Lab member with a verified email (filmmakers and admins always).
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
  const role = profile.role || 'viewer';
  // Admins, and partners given "Lab unlimited" in the admin panel, have no monthly limits.
  const unlimited = role === 'admin' || !!(await ops.dbGet(`flieks_lab_unlimited/${u.localId}`));
  return { uid: u.localId, email: u.email || '', role, name: profile.name || '', verified: !!u.emailVerified, unlimited };
}

const newId = () => crypto.randomBytes(15).toString('base64').replace(/[+/=]/g, '').slice(0, 20);
const validId = id => typeof id === 'string' && /^[A-Za-z0-9]{12,40}$/.test(id);
const jobSecret = () => crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':script-report').digest('hex');
const fundingSecret = () => crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':funding').digest('hex');
const FUNDING_PER_DAY = 5;                                             // searches per pitch, admins/partners exempt
const castSecret = () => crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':castmatch').digest('hex');
const MAX_MATCH_RUNS = 10;                                             // per report, admins exempt
const CONNECT_PER_DAY = parseInt(process.env.TALENT_CONNECT_PER_DAY || '20', 10);
const pitchSecret = () => crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':pitch').digest('hex');
const STAGES = ['Idea', 'Script', 'Financing', 'Pre-production', 'Shooting', 'Post-production', 'Finished'];
const MAX_PITCH_DRAFTS = 10;
const { normalisePitch } = require('../lib/script-report-core');
const { cleanRegions } = require('../lib/funding');

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
    updated_at: p.updated_at || p.created_at, is_owner: !!isOwner, report_id: isOwner ? p.report_id : null,
    // Funding research is the filmmaker's own working list, never shown to people they share the pitch with.
    funding: isOwner ? (p.funding || null) : undefined,
    // Funds the filmmaker chose to show partners: on the shared pitch and its PDF.
    targets: pitchTargets(p)
  };
}
const fundKey = o => String((o && (o.url || `${o.funder}|${o.programme}`)) || '').toLowerCase().replace(/\/+$/, '');
function pitchTargets(p) {
  const f = p.funding || {}, keep = new Set(Array.isArray(f.include) ? f.include : []);
  return (f.items || []).filter(o => o && keep.has(fundKey(o))).map(o => ({
    funder: o.funder, programme: o.programme || '', amount: o.amount || null, deadline: o.deadline || null,
    stage: o.stage || null, url: o.url || null
  }));
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
        view.cast_match = rec.cast_match || null;
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
      const ledger = await ops.dbGet(`flieks_lab_usage/${me.uid}/reports`) || {};
      const ids = new Set(items.filter(r => (r.created_at || 0) >= since).map(r => r.id));
      for (const [k, t] of Object.entries(ledger)) if ((Number(t) || 0) >= since) ids.add(k);
      const used = ids.size;
      return reply(200, { items, limit: me.unlimited ? null : LIMIT, used, role: me.role, verified: me.verified || me.unlimited, unlimited: me.unlimited });
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
      // Any Lab member with a verified email; filmmakers and admins are already known.
      if (me.role !== 'filmmaker' && !me.unlimited && !me.verified) {
        return reply(403, { code: 'verify', message: 'Verify your email first: open the link we sent you, then try again.' });
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

      const id = newId();
      const now = Date.now();
      // Check the limit and take this month's slot as one step, one start at a
      // time per person, so several starts at the same moment can't all get in.
      const slot = { title, created_at: now, status: 'queued' };
      if (me.unlimited) await ops.dbWrite(`flieks_script_reports_by_user/${me.uid}/${id}`, slot);
      else {
        let allowed;
        try {
          allowed = await ops.withLock(`report_${me.uid}`, async () => {
            // Usage is kept in its own ledger, which deleting a report does not
            // touch, so delete-and-rerun can't reset the monthly limit. Reports
            // from before the ledger existed still count.
            const [mine, ledger] = await Promise.all([
              ops.dbGet(`flieks_script_reports_by_user/${me.uid}`).then(v => v || {}),
              ops.dbGet(`flieks_lab_usage/${me.uid}/reports`).then(v => v || {})
            ]);
            const since = now - 30 * DAY, ids = new Set();
            for (const [k, r] of Object.entries(mine)) if ((r && r.created_at || 0) >= since) ids.add(k);
            for (const [k, t] of Object.entries(ledger)) if ((Number(t) || 0) >= since) ids.add(k);
            if (ids.size >= LIMIT) return false;
            await ops.dbWrite(`flieks_lab_usage/${me.uid}/reports/${id}`, now);
            await ops.dbWrite(`flieks_script_reports_by_user/${me.uid}/${id}`, slot);
            return true;
          });
        } catch (e) {
          if (e.busy) return reply(429, { message: 'Another report is starting. Try again in a moment.' });
          throw e;
        }
        if (!allowed) return reply(429, { message: `You've used your ${LIMIT} script reports for this month. More open up as the month rolls on.` });
      }
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
      if ((await ops.dbIncrement(`flieks_ops/locks/pitch_${pid}_${Math.floor(Date.now() / 30000)}`)) > 1) return reply(200, { ok: true, pid });
      if (drafts >= MAX_PITCH_DRAFTS && !me.unlimited) {
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
      await ops.logLabEvent('pitch', me.uid, { title: rec.title, report: body.id });
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

    /* ---- funding open now (live web search) ---- */
    if (action === 'funding-include') {
      if (!validId(body.pid)) return reply(404, { message: 'Pitch not found.' });
      const pitch = await ops.dbGet(`flieks_pitches/${body.pid}`);
      if (!pitch || (pitch.owner !== me.uid && me.role !== 'admin')) return reply(404, { message: 'Pitch not found.' });
      const known = new Set(((pitch.funding || {}).items || []).map(fundKey));
      const keys = (Array.isArray(body.keys) ? body.keys : []).map(k => String(k).toLowerCase().replace(/\/+$/, '')).filter(k => known.has(k)).slice(0, 8);
      await ops.dbWrite(`flieks_pitches/${body.pid}/funding/include`, keys.length ? keys : null);
      return reply(200, { ok: true, targets: pitchTargets({ funding: { ...pitch.funding, include: keys } }) });
    }

    if (action === 'funding-start') {
      if (!validId(body.pid)) return reply(404, { message: 'Pitch not found.' });
      const pitch = await ops.dbGet(`flieks_pitches/${body.pid}`);
      if (!pitch || (pitch.owner !== me.uid && me.role !== 'admin')) return reply(404, { message: 'Pitch not found.' });
      const f = pitch.funding || {};
      if ((f.status === 'queued' || f.status === 'working') && Date.now() - (f.at || 0) < 15 * 60e3) return reply(200, { ok: true });
      // Two taps at the same moment start one search, not two.
      if ((await ops.dbIncrement(`flieks_ops/locks/funding_${body.pid}_${Math.floor(Date.now() / 30000)}`)) > 1) return reply(200, { ok: true });
      const day = new Date().toISOString().slice(0, 10);
      const runs = f.day === day ? (f.runs || 0) : 0;
      if (runs >= FUNDING_PER_DAY && !me.unlimited) {
        return reply(429, { message: `That's ${FUNDING_PER_DAY} funding searches for this pitch today. Try again tomorrow.` });
      }
      const regions = cleanRegions(body.regions);
      await ops.dbWrite(`flieks_pitches/${body.pid}/funding`, { ...f, status: 'queued', regions, error: null, at: Date.now(), day, runs: runs + 1 });
      const base = process.env.URL || 'https://4flieks.com';
      const kick = await fetch(`${base}/.netlify/functions/funding-background`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-job-secret': fundingSecret() },
        body: JSON.stringify({ pid: body.pid })
      }).catch(() => ({ ok: false, status: 0 }));
      if (!kick.ok && kick.status !== 202) {
        await ops.dbWrite(`flieks_pitches/${body.pid}/funding`, { status: 'error', error: 'Could not start the search. Try again.' }, 'PATCH');
        return reply(502, { message: 'Could not start the search. Try again.' });
      }
      return reply(200, { ok: true });
    }

    /* ---- cast match ---- */
    if (action === 'match-start') {
      if (!validId(body.id)) return reply(404, { message: 'Report not found.' });
      const rec = await ops.dbGet(`flieks_script_reports/${body.id}`);
      if (!rec || (rec.owner !== me.uid && me.role !== 'admin')) return reply(404, { message: 'Report not found.' });
      if (rec.status !== 'done') return reply(409, { message: 'The report is not ready yet.' });
      const prev = rec.cast_match || {};
      if (prev.status === 'queued' || prev.status === 'working') return reply(200, { ok: true });
      const runs = prev.runs || 0;
      if (runs >= MAX_MATCH_RUNS && !me.unlimited) {
        return reply(429, { message: `That's ${MAX_MATCH_RUNS} cast searches for this script. New actors join all the time, so try again next month.` });
      }
      await ops.dbWrite(`flieks_script_reports/${body.id}/cast_match`, {
        status: 'queued', runs: runs + 1, at: Date.now(), sent: prev.sent || null
      });
      const base = process.env.URL || 'https://4flieks.com';
      const kick = await fetch(`${base}/.netlify/functions/cast-match-background`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-job-secret': castSecret() },
        body: JSON.stringify({ id: body.id })
      }).catch(() => ({ ok: false, status: 0 }));
      if (!kick.ok && kick.status !== 202) {
        await ops.dbWrite(`flieks_script_reports/${body.id}/cast_match`, { status: 'error', error: 'Could not start the search. Try again.' }, 'PATCH');
        return reply(502, { message: 'Could not start the search. Try again.' });
      }
      await ops.logLabEvent('cast_search', me.uid, { title: rec.title, report: body.id });
      return reply(200, { ok: true });
    }

    if (action === 'connect') {
      if (!validId(body.id)) return reply(404, { message: 'Report not found.' });
      const talentUid = String(body.talentUid || '');
      if (talentUid.startsWith('as:')) return reply(400, { message: 'Contact this actor through their Actors Spaces profile.' });
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(talentUid)) return reply(400, { message: 'Bad request.' });
      const rec = await ops.dbGet(`flieks_script_reports/${body.id}`);
      if (!rec || (rec.owner !== me.uid && me.role !== 'admin')) return reply(404, { message: 'Report not found.' });
      const cm = rec.cast_match || {};
      // Only someone this search actually suggested, who is still opted in.
      if (!cm.people || !cm.people[talentUid]) return reply(404, { message: 'That actor is not in your suggestions.' });
      if (cm.sent && cm.sent[talentUid]) return reply(409, { message: 'You have already asked them about this script.' });
      const t = await ops.dbGet(`flieks_talent/${talentUid}`);
      if (!t || t.suggest !== true || !t.email) return reply(410, { message: 'They are no longer taking suggestions.' });

      const message = String(body.message || '').trim().slice(0, 1200);
      const character = String(body.character || '').trim().slice(0, 80);
      if (message.length < 20) return reply(400, { message: 'Say a little about the project and the role (a sentence or two).' });

      const day = new Date().toISOString().slice(0, 10);
      const countPath = `flieks_ops/talent_connect/${me.uid}/${day}`;
      if (!me.unlimited && !(await ops.takeSlot(countPath, CONNECT_PER_DAY))) return reply(429, { message: `That's ${CONNECT_PER_DAY} requests today. Try again tomorrow.` });
      const giveBack = () => me.unlimited ? null : ops.dbIncrement(countPath, -1).catch(() => {});

      const from = me.name || rec.writer || 'A 4flieks filmmaker';
      const replyTo = me.email || rec.owner_email;
      const lines = [
        `Hi ${t.name},`,
        '',
        `${from} is casting "${rec.title}" and 4flieks suggested you${character ? ` for the role of ${character}` : ''}, because you switched on "Suggest me to filmmakers" on your talent profile.`,
        '',
        'Their message:',
        '',
        message,
        '',
        `Just reply to this email to answer them. It goes straight to ${from}${replyTo ? ` (${replyTo})` : ''}.`,
        'Your email address was not shown to them; they will see it only if you reply.',
        '',
        `Not interested in suggestions any more? Switch it off at ${ops.SITE}/talent`,
        '',
        '4flieks'
      ];
      const sent = await ops.sendEmailTo({
        to: t.email, replyTo,
        subject: `Casting: ${rec.title}${character ? ` (${character})` : ''}`,
        text: lines.join('\n')
      });
      if (!sent || !sent.ok) {
        console.error('[connect] email failed', sent && sent.reason);
        await giveBack();
        return reply(502, { message: 'The email could not be sent. Try again in a minute.' });
      }
      await ops.dbWrite(`flieks_script_reports/${body.id}/cast_match/sent/${talentUid}`, { at: Date.now(), character });
      await ops.logLabEvent('connect', me.uid, { title: rec.title, report: body.id });
      return reply(200, { ok: true });
    }

    return reply(400, { message: 'Unknown action.' });
  } catch (e) {
    console.error('[script-report]', e);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};

module.exports.jobSecret = jobSecret;
