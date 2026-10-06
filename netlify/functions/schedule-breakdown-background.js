/**
 * schedule-breakdown-background — reads a screenplay into a scene breakdown
 * for the Lab scheduler (Budget & call sheets → Schedule).
 *
 * Only flieks-budget (which checks the member, their email and their monthly
 * limit) can start it: it must present a hashed per-purpose secret (audit M4).
 * Runs up to 15 minutes. Progress and the result go to flieks_budget_jobs/<jobId>,
 * which the owner polls through flieks-budget and which is deleted once read.
 * The script itself is never stored.
 *
 * The script is untrusted text: whatever it says, the model can only return
 * short strings and numbers, which schedule-core cleans and the page escapes.
 *
 * Env: ANTHROPIC_API_KEY, FIREBASE_DB_URL, FIREBASE_DB_SECRET (existing)
 *      SCHEDULE_MODEL (optional, default claude-haiku-4-5-20251001)
 */
const crypto = require('crypto');
const ops = require('../lib/ops-core');
const sc = require('../lib/schedule-core');
const { looksScanned, transcribePdf } = require('../lib/coach-extract');

const MODEL = process.env.SCHEDULE_MODEL || 'claude-haiku-4-5-20251001';
const jobSecret = () => crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':schedule-breakdown').digest('hex');

async function askClaude(system, user, fetchImpl = fetch) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 12000, system, messages: [{ role: 'user', content: user }] })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error('model ' + r.status); e.status = r.status; throw e; }
      return (d.content || []).filter(x => x.type === 'text').map(x => x.text).join('');
    } catch (e) {
      lastErr = e;
      if (e.status === 400 || e.status === 401 || e.status === 403) break;
      await new Promise(r => setTimeout(r, e.status === 429 || e.status === 529 ? 8000 : 2000));
    }
  }
  throw lastErr;
}

exports.handler = async event => {
  const given = String((event.headers || {})['x-job-secret'] || '');
  const want = jobSecret();
  if (given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) {
    console.warn('schedule-breakdown-background: refused, not started by flieks-budget');
    return { statusCode: 403 };
  }
  let jobId, owner;
  const stage = s => ops.dbWrite(`flieks_budget_jobs/${jobId}`, { owner, kind: 'breakdown', status: 'reading', stage: s, at: Date.now() }).catch(() => {});
  try {
    const b = JSON.parse(event.body || '{}');
    jobId = String(b.jobId || ''); owner = String(b.owner || '');
    if (!/^j[a-f0-9]{20}$/.test(jobId) || !/^[A-Za-z0-9]{10,128}$/.test(owner)) return { statusCode: 400 };
    const job = await ops.dbGet(`flieks_budget_jobs/${jobId}`);
    if (!job || job.owner !== owner || job.status !== 'queued' || job.kind !== 'breakdown') return { statusCode: 409 };   // each job runs once
    const title = sc.cleanBreakdown({ title: b.title }).title;
    await stage('Reading the script…');

    // 1. pages
    let pages = [], estimated = false, scanned = false;
    const ext = String(b.fileName || '').toLowerCase().split('.').pop();
    if (typeof b.text === 'string' && b.text.trim()) { pages = sc.pagesFromText(b.text.slice(0, 600000)); estimated = true; }
    else if (typeof b.fileBase64 === 'string' && ext === 'pdf') {
      const buf = Buffer.from(b.fileBase64, 'base64');
      const r = await sc.pagesFromPdf(buf).catch(() => ({ pages: [], numpages: 0, chars: 0 }));
      pages = r.pages;
      if (looksScanned(pages.join('\n'), r.numpages)) {
        scanned = true; estimated = true;
        try {
          const ocr = await transcribePdf(buf, title, { apiKey: process.env.ANTHROPIC_API_KEY, onProgress: stage });
          pages = sc.pagesFromText(ocr.text);
        } catch (e) {
          return fail(e.code === 'too_long' ? `This scan has ${e.pages} pages, more than the scheduler can read in one go.` : 'The AI couldn\'t read the scanned pages. Try a clearer scan, or a text PDF.');
        }
      }
    } else if (typeof b.fileBase64 === 'string' && ext === 'docx') {
      const mammoth = require('mammoth');
      const r = await mammoth.extractRawText({ buffer: Buffer.from(b.fileBase64, 'base64') });
      pages = sc.pagesFromText(r.value); estimated = true;
    } else return fail('Upload the script as a PDF or Word file, or paste it.');

    // 2. scenes, found in code
    const scenes = sc.splitScenes(pages);
    if (scenes.length < 2) return fail('No scene headings found. The scheduler looks for lines like "INT. KITCHEN – NIGHT". Is this a screenplay?');

    // 3. the AI reads each group of scenes; locations and cast found so far go into the next call
    const groups = sc.chunks(scenes);
    const out = [], locs = [], cast = [];
    for (let i = 0; i < groups.length; i++) {
      await stage(`Breaking down the scenes: ${out.length} of ${scenes.length} done…`);
      let ai = [];
      try { ai = sc.parseJsonArray(await askClaude(sc.SYSTEM, sc.userPrompt(groups[i], locs, cast, title))); }
      catch (e) { console.error('[schedule-breakdown] AI', e && e.message); if (e && (e.status === 401 || e.status === 403)) return fail('The AI is not available right now. Try again later.'); }
      const merged = sc.mergeAi(groups[i], ai);
      merged.forEach(s => {
        if (s.loc && !locs.some(l => l.toLowerCase() === s.loc.toLowerCase())) locs.push(s.loc);
        s.cast.forEach(c => { if (!cast.includes(c)) cast.push(c); });
      });
      out.push(...merged);
    }
    const result = sc.cleanBreakdown({ title, pages: pages.length, estimated, scanned, scenes: out });
    await ops.dbWrite(`flieks_budget_jobs/${jobId}`, { owner, kind: 'breakdown', status: 'done', result, at: Date.now() });
    console.log(`[schedule-breakdown] ${jobId}: ${result.scenes.length} scenes, ${pages.length} pages, ${groups.length} AI calls`);
    return { statusCode: 200 };
  } catch (e) {
    console.error('[schedule-breakdown-background]', e && e.message);
    return fail('Could not read that script. Try again.');
  }
  async function fail(message) {
    if (jobId && owner) await ops.dbWrite(`flieks_budget_jobs/${jobId}`, { owner, kind: 'breakdown', status: 'error', error: message, at: Date.now() }).catch(() => {});
    return { statusCode: 200 };
  }
};
