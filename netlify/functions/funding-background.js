/**
 * funding-background — searches the web for funding that is open now for a pitch.
 * Started by flieks-script-report (action funding-start) with a shared secret.
 * Writes flieks_pitches/<pid>/funding for the owner's pitch page to poll.
 */
const crypto = require('crypto');
const ops = require('../lib/ops-core');
const { findFunding, projectBrief } = require('../lib/funding');

const secret = () => crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':funding').digest('hex');

exports.handler = async event => {
  const given = String((event.headers || {})['x-job-secret'] || '');
  const want = secret();
  if (given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) return { statusCode: 403 };
  let pid;
  const set = f => ops.dbWrite(`flieks_pitches/${pid}/funding`, f, 'PATCH');
  try {
    ({ pid } = JSON.parse(event.body || '{}'));
    if (!/^[A-Za-z0-9]{12,40}$/.test(pid || '')) return { statusCode: 400 };
    const pitch = await ops.dbGet(`flieks_pitches/${pid}`);
    if (!pitch || !pitch.funding || pitch.funding.status !== 'queued') return { statusCode: 200 };
    await set({ status: 'working' });
    const report = pitch.report_id ? await ops.dbGet(`flieks_script_reports/${pitch.report_id}/report`) : null;
    const r = await findFunding(projectBrief(pitch, report), { regions: pitch.funding.regions });
    console.log('[funding]', pid, `${r.items.length} opportunities, ${r.searches} searches, ${r.dropped} dropped (no matching source)`);
    await set({ status: 'done', regions: r.regions, items: r.items, note: r.note || null, error: null, checked_at: Date.now() });
    await ops.logLabEvent('funding', pitch.owner, { title: pitch.title, report: pitch.report_id || null });
  } catch (e) {
    console.error('[funding]', pid, e);
    if (pid) await set({ status: 'error', error: String(e.message || e).slice(0, 300) }).catch(() => {});
  }
  return { statusCode: 200 };
};
