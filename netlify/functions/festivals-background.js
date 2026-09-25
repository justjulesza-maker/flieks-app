/**
 * festivals-background — adds 'Festivals to aim for' to Script Reports written
 * before festivals were part of the report. Started from the control centre
 * (flieks-ops, admin only) with a shared secret. Works from the report itself;
 * the script is not needed. Progress in flieks_ops/festival_backfill.
 */
const crypto = require('crypto');
const ops = require('../lib/ops-core');
const { suggestFestivals } = require('../lib/script-report-core');

const PARALLEL = 3;
const secret = () => crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':festivals').digest('hex');
const needsFestivals = rec => rec && rec.status === 'done' && rec.report && !Array.isArray(rec.report.festivals);

exports.handler = async event => {
  const given = String((event.headers || {})['x-job-secret'] || '');
  const want = secret();
  if (given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) return { statusCode: 403 };
  const status = f => ops.dbWrite('flieks_ops/festival_backfill', f, 'PATCH').catch(() => {});
  try {
    const all = await ops.dbGet('flieks_script_reports') || {};
    const ids = Object.entries(all).filter(([, r]) => needsFestivals(r)).map(([id]) => id);
    await status({ status: 'working', total: ids.length, done: 0, failed: 0, started_at: Date.now() });
    let done = 0, failed = 0, next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        try {
          const f = await suggestFestivals(all[id].report);
          await ops.dbWrite(`flieks_script_reports/${id}/report`, f, 'PATCH');
          done++;
        } catch (e) {
          console.error('[festivals]', id, e.message);
          failed++;
        }
        await status({ done, failed });
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, ids.length) }, worker));
    await status({ status: 'done', done, failed, finished_at: Date.now() });
  } catch (e) {
    console.error('[festivals]', e);
    await status({ status: 'error', error: String(e.message || e).slice(0, 200), finished_at: Date.now() });
  }
  return { statusCode: 200 };
};

module.exports.secret = secret;
module.exports.needsFestivals = needsFestivals;
