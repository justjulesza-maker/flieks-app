/**
 * script-report-background — reads one screenplay and writes its report.
 *
 * Called only by flieks-script-report (shared secret), never by a browser.
 * Netlify answers 202 straight away and this runs for up to 15 minutes,
 * writing its progress to flieks_script_reports/<id> for the page to poll.
 */
const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const ops = require('../lib/ops-core');
const { analyse } = require('../lib/script-report-core');

const MAX_BYTES = 30 * 1024 * 1024;
const jobSecret = () => crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':script-report').digest('hex');

async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not fetch the script (${r.status}).`);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error('That file is over 30MB.');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('That file is over 30MB.');
  return buf;
}

exports.handler = async event => {
  let id;
  const set = async fields => {
    await ops.dbWrite(`flieks_script_reports/${id}`, fields, 'PATCH');
  };
  try {
    const h = event.headers || {};
    const given = h['x-job-secret'] || h['X-Job-Secret'] || '';
    const want = jobSecret();
    if (given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) {
      console.warn('[script-report-bg] refused: bad secret');
      return { statusCode: 403 };
    }
    ({ id } = JSON.parse(event.body || '{}'));
    if (!/^[A-Za-z0-9]{12,40}$/.test(id || '')) return { statusCode: 400 };

    const rec = await ops.dbGet(`flieks_script_reports/${id}`);
    if (!rec || rec.status !== 'queued') return { statusCode: 200 };

    await set({ status: 'working', stage: 'Reading the file…' });
    const buf = await download(rec.file_url);
    if (buf.slice(0, 5).toString() !== '%PDF-') throw new Error('That file is not a PDF.');

    let text = '', pages = null;
    try {
      const pdf = await pdfParse(buf);
      text = pdf.text || '';
      pages = pdf.numpages || null;
    } catch (e) {
      throw new Error('Could not read that PDF. Export it again from your screenwriting app and retry.');
    }
    if (text.replace(/\s+/g, '').length < 800) {
      throw new Error('Almost no text came out of that PDF. If it is a scan, export a text PDF from your screenwriting app instead.');
    }

    await set({ stage: `Reading ${pages ? pages + ' pages' : 'the script'}… this takes a few minutes.`, pages });
    const report = await analyse(text, { title: rec.title, writer: rec.writer });
    if (pages && !report.format.pages) report.format.pages = pages;

    const now = Date.now();
    await set({ status: 'done', stage: null, report, finished_at: now });
    await ops.dbWrite(`flieks_script_reports_by_user/${rec.owner}/${id}`, { status: 'done', verdict: report.verdict.label }, 'PATCH');
    console.log('[script-report-bg] done', id, report.meta && report.meta.usage);
    return { statusCode: 200 };
  } catch (e) {
    console.error('[script-report-bg]', id, e);
    if (id) {
      await set({ status: 'error', error: String(e.message || e).slice(0, 300), finished_at: Date.now() }).catch(() => {});
      const rec = await ops.dbGet(`flieks_script_reports/${id}`).catch(() => null);
      if (rec && rec.owner) await ops.dbWrite(`flieks_script_reports_by_user/${rec.owner}/${id}`, { status: 'error' }, 'PATCH').catch(() => {});
    }
    return { statusCode: 200 };
  }
};
