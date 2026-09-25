/**
 * funding — current funding opportunities for a project, found by live web search.
 *
 * Calls open and close all year, so nothing here is stored as fact: the AI searches
 * the web each time (Anthropic's web search tool), starting from the funders below.
 * Every opportunity must link to a page that the search actually returned, or it is
 * dropped, so no invented calls or links reach the filmmaker.
 */
const MODEL = process.env.FUNDING_MODEL || process.env.SCRIPT_REPORT_MODEL || 'claude-sonnet-5';
const TOOL = process.env.FUNDING_SEARCH_TOOL || 'web_search_20250305';

/* Where to start looking, by region. Names only: the search finds the current pages. */
const REGIONS = {
  za: { label: 'South Africa', funders: [
    'National Film and Video Foundation (NFVF): development, production, marketing and distribution funding, bursaries',
    'Department of Trade, Industry and Competition (dtic): film and TV production incentives, including for emerging Black filmmakers',
    'Industrial Development Corporation (IDC): media and motion pictures funding',
    'Gauteng Film Commission', 'KwaZulu-Natal Film Commission',
    'Durban FilmMart (project market with finance awards)'
  ] },
  africa: { label: 'Rest of Africa', funders: [
    'Realness Institute (screenwriting and episodic labs, Africa)',
    'Africa No Filter (grants for African storytellers)',
    'Pitch forums and markets with cash awards at African festivals (e.g. AFRIFF, Kalasha, FESPACO, Atlas Workshops Marrakech)',
    'National film funds and commissions in other African countries (e.g. Nigeria, Kenya, Ghana, Rwanda, Morocco, Senegal)'
  ] },
  europe: { label: 'Europe', funders: [
    'Hubert Bals Fund (IFFR, Netherlands)', 'IDFA Bertha Fund (Netherlands; documentary, Africa and the Global South)',
    'World Cinema Fund (Berlinale, Germany)', 'Aide aux cinémas du monde (CNC and Institut français, France)',
    'Visions Sud Est (Switzerland)', 'Open Doors (Locarno, Switzerland)', 'Final Cut in Venice (Italy; post-production)',
    'Eurimages co-production support (Council of Europe; needs European co-producers)',
    'Creative Europe MEDIA (needs a European production company)'
  ] },
  intl: { label: 'International (USA, Middle East, global)', funders: [
    'Doha Film Institute grants (Qatar)', 'Red Sea Fund (Saudi Arabia)',
    'Sundance Institute Documentary Fund and labs (USA)', 'Hot Docs Blue Ice Docs Fund (Canada; African documentary)',
    'Other international film funds open to African filmmakers'
  ] }
};
const DEFAULT_REGIONS = ['za', 'africa'];
const cleanRegions = list => {
  const r = (Array.isArray(list) ? list : []).filter(k => REGIONS[k]);
  return r.length ? [...new Set(r)] : DEFAULT_REGIONS.slice();
};

const SYSTEM = `You find CURRENT funding opportunities for African independent film projects, for 4flieks Lab.
Use web search. Only look for funding from the REGIONS the filmmaker chose (in the user message). Start with
the funders listed for those regions, then search more widely within them for open calls that fit the project
(film funds, grants, incentives, labs with funding, pitching competitions with cash awards, co-production funds).

Rules:
- Only include an opportunity if you found its page in THIS search, and give that page's exact URL.
- Only calls that are open now, opening within about three months, or rolling (always open). Leave out closed ones.
- Quote amounts and deadlines exactly as the funder's page states them, with the year; if the page doesn't say, use null.
- Match the project's format, stage, genre and languages; check eligibility (country, experience, format) and say it plainly.
- The filmmaker is most likely based in South Africa (4flieks is a South African platform). For funds outside their
  country, say plainly what eligibility needs (e.g. a co-producer from that country, a sales agent, a festival selection).
- Never invent a programme, amount, deadline or link. Fewer, verified results beat more guesses.

When you have searched enough, reply with ONLY this JSON (no fences, no commentary):
{"opportunities": [{"funder": string, "programme": string, "what": string (max 25 words: what it funds),
  "amount": string or null, "deadline": string or null, "status": "open" | "upcoming" | "rolling",
  "stage": "development" | "production" | "post-production" | "distribution" | "training",
  "region": "za" | "africa" | "europe" | "intl" (where the funder is),
  "eligibility": string (max 25 words), "fit": string (max 25 words: why it suits THIS project), "url": string}] (0-10, best fit first),
 "note": string (one sentence: anything the filmmaker should know, e.g. what to prepare)}

The chosen regions, and the funders to check first in each, come in the user message.`;

function request(url, opts = {}, body = null) {
  const https = require('https');
  return new Promise((res, rej) => {
    const r = https.request(url, opts, x => {
      let d = ''; x.on('data', c => d += c);
      x.on('end', () => res({ status: x.statusCode, body: d }));
    });
    r.on('error', rej);
    r.setTimeout(600000, () => r.destroy(new Error('search timed out')));
    if (body) r.write(body);
    r.end();
  });
}

const str = (v, n) => (v == null ? '' : String(v)).trim().slice(0, n);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
/* The site a link belongs to, ignoring www. and sub-sites: nfvf.co.za, iffr.com, gov.za → thedtic.gov.za. */
const siteOf = u => {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return null;
    const h = x.hostname.toLowerCase().replace(/^www\./, '').split('.');
    // co.za, org.za, gov.za, co.uk, com.ng … keep three labels; otherwise two.
    const keep = h.length > 2 && /^(co|org|gov|ac|net|com|or|go|edu)$/.test(h[h.length - 2]) && h[h.length - 1].length === 2 ? 3 : 2;
    return h.slice(-keep).join('.');
  } catch { return null; }
};

/** What the project is, for the search. From the pitch and its report. */
function projectBrief(pitch, report) {
  const r = report || {}, det = (pitch && pitch.details) || {};
  return {
    title: (pitch && pitch.title) || r.title,
    logline: (pitch && pitch.copy && pitch.copy.logline) || r.logline,
    format: r.format || null,
    stage: det.stage || 'Script',
    what_they_need: det.ask || null,
    genres: (r.genres || []).map(g => g.genre),
    languages: r.languages || [],
    budget_band: r.production ? r.production.budget_band : null
  };
}

async function findFunding(brief, { regions, apiKey = process.env.ANTHROPIC_API_KEY, requestImpl = request } = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const chosen = cleanRegions(regions);
  const where = chosen.map(k => `${k} = ${REGIONS[k].label}. Check first:\n${REGIONS[k].funders.map(f => '  - ' + f).join('\n')}`).join('\n');
  const messages = [{ role: 'user', content: `The project:\n${JSON.stringify(brief)}\n\nREGIONS to search (only these):\n${where}\n\n` +
    `Today is ${new Date().toISOString().slice(0, 10)}. Find current funding opportunities for it.` }];
  const found = new Set();         // every URL the search returned or cited
  const collect = content => (content || []).forEach(b => {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) b.content.forEach(x => x && x.url && found.add(x.url));
    if (b.type === 'text' && Array.isArray(b.citations)) b.citations.forEach(c => c && c.url && found.add(c.url));
  });
  let data, searches = 0;
  for (let turn = 0; turn < 4; turn++) {
    const body = JSON.stringify({
      model: MODEL, max_tokens: 8000, system: SYSTEM, messages,
      tools: [{ type: TOOL, name: 'web_search', max_uses: 6 + 2 * chosen.length,
        ...(chosen.length === 1 && chosen[0] === 'za' ? { user_location: { type: 'approximate', country: 'ZA' } } : {}) }]
    });
    const r = await requestImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    }, body);
    data = JSON.parse(r.body || '{}');
    if (data.error) {
      const m = String(data.error.message || '');
      if (/web.?search/i.test(m)) throw Object.assign(new Error('Web search is not switched on for the 4flieks AI account. An admin can enable it in the Anthropic Console, then try again.'), { code: 'search-off' });
      throw new Error(m || 'AI error');
    }
    collect(data.content);
    searches += (data.content || []).filter(b => b.type === 'server_tool_use').length;
    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content });   // a long search continues where it paused
  }
  const errs = (data.content || []).filter(b => b.type === 'web_search_tool_result' && b.content && b.content.error_code);
  // The answer is the text after the last search.
  const blocks = data.content || [];
  let lastTool = -1; blocks.forEach((b, i) => { if (b.type === 'web_search_tool_result') lastTool = i; });
  const text = blocks.slice(lastTool + 1).filter(b => b.type === 'text').map(b => b.text).join('');
  const a = text.indexOf('{'), z = text.lastIndexOf('}');
  if (a < 0 || z <= a) {
    if (errs.length && !found.size) throw new Error('The web search did not work just now. Try again in a few minutes.');
    throw new Error('The search came back without results. Try again.');
  }
  let raw;
  try { raw = JSON.parse(text.slice(a, z + 1)); } catch { throw new Error('The results could not be read. Try again.'); }
  const foundSites = new Set([...found].map(siteOf).filter(Boolean));
  const dropped = [];
  const items = (Array.isArray(raw.opportunities) ? raw.opportunities : []).map(o => {
    const url = str(o && o.url, 500);
    // The link must be a page the search returned, or on the same site as one.
    // The link must be a page the search returned, or on the same website as one.
    if (!url || !siteOf(url) || !(found.has(url) || foundSites.has(siteOf(url)))) {
      if (o && o.funder) dropped.push({ funder: str(o.funder, 100), url: url || null });
      return null;
    }
    return {
      funder: str(o.funder, 100), programme: str(o.programme, 140), what: str(o.what, 220),
      amount: str(o.amount, 120) || null, deadline: str(o.deadline, 120) || null,
      status: oneOf(o.status, ['open', 'upcoming', 'rolling'], 'open'),
      region: oneOf(o.region, chosen, chosen[0]),
      stage: oneOf(o.stage, ['development', 'production', 'post-production', 'distribution', 'training'], 'development'),
      eligibility: str(o.eligibility, 220), fit: str(o.fit, 220), url
    };
  }).filter(o => o && o.funder).slice(0, 10);
  return { regions: chosen, items, note: str(raw.note, 300), searches, found: found.size,
    proposed: (raw.opportunities || []).length, dropped };
}

module.exports = { findFunding, projectBrief, REGIONS, DEFAULT_REGIONS, cleanRegions, SYSTEM };
