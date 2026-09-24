/**
 * pitch-writer-background — writes a one-page pitch from a finished Script
 * Report and the filmmaker's details. Called only by flieks-script-report
 * (shared secret). Progress and the result go to flieks_pitches/<pid>.
 */
const crypto = require('crypto');
const ops = require('../lib/ops-core');
const { writePitch } = require('../lib/script-report-core');

const pitchSecret = () => crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':pitch').digest('hex');

exports.handler = async event => {
  const given = String((event.headers || {})['x-job-secret'] || '');
  const want = pitchSecret();
  if (given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) return { statusCode: 403 };
  let pid;
  try {
    ({ pid } = JSON.parse(event.body || '{}'));
    if (!/^[A-Za-z0-9]{12,40}$/.test(pid || '')) return { statusCode: 400 };
    const pitch = await ops.dbGet(`flieks_pitches/${pid}`);
    if (!pitch || pitch.status !== 'queued') return { statusCode: 200 };
    await ops.dbWrite(`flieks_pitches/${pid}`, { status: 'working' }, 'PATCH');
    const rec = await ops.dbGet(`flieks_script_reports/${pitch.report_id}`);
    if (!rec || !rec.report) throw new Error('The report behind this pitch is gone.');
    const copy = await writePitch(rec.report, pitch.details || {});
    await ops.dbWrite(`flieks_pitches/${pid}`, { status: 'done', copy, error: null, updated_at: Date.now() }, 'PATCH');
    return { statusCode: 200 };
  } catch (e) {
    console.error('[pitch-writer]', pid, e);
    if (pid) await ops.dbWrite(`flieks_pitches/${pid}`, { status: 'error', error: String(e.message || e).slice(0, 300) }, 'PATCH').catch(() => {});
    return { statusCode: 200 };
  }
};
