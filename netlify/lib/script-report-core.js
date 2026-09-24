/**
 * script-report-core — the Script Report's brain.
 *
 * A screenplay's text goes in; a structured coverage report comes out:
 * logline, synopsis, verdict and scores, genre mix, emotion arc, structure,
 * characters, audience, comparables, strengths, development notes, production
 * footprint, and how to release it on 4flieks.
 *
 * Everything is normalised after the model answers, so the page can trust the
 * shape (numbers in range, lists capped, no missing keys).
 */
const MODEL = process.env.SCRIPT_REPORT_MODEL || 'claude-sonnet-5';
const MAX_SCRIPT_CHARS = 380000;   // a long feature is ~200k; leaves room without blowing the context

const EMOTIONS = ['joy', 'hope', 'love', 'humour', 'tension', 'fear', 'sadness', 'anger', 'surprise'];

const SYSTEM = `You are a senior script reader and development executive writing coverage for an African independent
film platform, 4flieks (4flieks.com), based in South Africa. Filmmakers upload a document and receive your
report; many will share it with funders.

The document may be a SCREENPLAY, a TREATMENT or outline, or PROSE (a short story, novel extract or
synopsis). Decide which first. A screenplay gets normal coverage. A treatment or prose is judged as SOURCE
MATERIAL for a film: how well it would adapt, what film it could become, and what the adaptation needs.
For those, fill every section as if for the film you recommend making from it (emotion arc and structure
of the story; characters' share of the story rather than of dialogue; production footprint and release of
the recommended film). Be honest, specific and useful: praise what works, name what doesn't, and point to
pages or scenes. Write in plain, warm, professional English. African context matters: the story's own
country and region, its languages, places and audiences, and the realities of low-budget production across
the continent. Do not assume a South African setting unless the text is set there.

Rules:
- Only use what is in the script. Never invent facts about the writer, the production or real people.
- Never name real actors for casting; describe the kind of performer instead.
- Comparable titles must be real films or series you are confident exist. Prefer African titles, from
  anywhere on the continent, where they genuinely fit. If unsure, give fewer.
- If the text looks garbled or incomplete, or is not a story at all (an invoice, an essay), say so plainly
  in the verdict and keep everything else short.
- 4flieks pricing: shorts usually rent for R25 and sell for R49; features up to about R35 rent and R59 own.
- Return ONLY one JSON object, no markdown fences, no commentary, exactly this shape:

{
 "title": string,
 "writer": string or null (only if printed on the script),
 "source": {"kind": "screenplay" | "treatment" | "prose" | "other", "note": string (one line on what the document is)},
 "format": {"type": "short" | "feature" | "episode" | "other" (for prose/treatment: the film format it best suits), "pages": integer or null, "est_runtime_mins": integer or null (of the film)},
 "logline": string (max 45 words),
 "synopsis": string (120-200 words, spoilers allowed),
 "verdict": {"label": "Strong" | "Promising" | "Needs work", "summary": string (2-3 sentences)},
 "scores": {"concept": {"score": 1-10, "why": string}, "character": {...}, "dialogue": {...} (for prose: the voice, including any dialogue), "structure": {...}, "marketability": {...}},
 "genres": [{"genre": string, "pct": integer}] (1-4 items, pct sums to 100),
 "tone": string (a short phrase),
 "themes": [string] (3-5),
 "emotion_arc": [{"n": integer from 1, "pages": string, "moment": string (max 10 words), "emotion": one of ${EMOTIONS.join(' | ')}, "intensity": 0-10, "valence": -5 to 5}] (10-20 points in story order, covering the whole script),
 "structure": {"acts": [{"name": string, "pages": string, "summary": string}], "inciting_incident": string, "midpoint": string, "climax": string, "pacing": string},
 "characters": [{"name": string, "role": "lead" | "supporting" | "minor", "description": string, "arc": string, "dialogue_share": integer (screenplay: approx % of all dialogue lines; otherwise approx % of the story they carry), "casting": string (age range, qualities, languages; no real names)}] (up to 10, most important first),
 "adaptation": null for a screenplay; otherwise {"potential": "High" | "Medium" | "Low", "best_format": "short" | "feature" | "series", "length": string (e.g. "12-15 minute short"), "approach": string (2-4 sentences on how to adapt it), "keep": [string] (what must survive), "cut": [string] (what to lose or compress), "invent": [string] (what the film needs that the text lacks: scenes, dialogue, visual set pieces)},
 "languages": [string] (languages spoken in the dialogue),
 "audience": {"primary": string, "secondary": string, "why": string, "markets": [string], "age_rating": string},
 "comparables": [{"title": string, "year": integer, "why": string}] (0-5),
 "strengths": [string] (3-5),
 "notes": [{"area": string, "note": string, "where": string or null}] (4-8 actionable development notes),
 "production": {"speaking_roles": integer, "locations": integer, "night_scenes": "few" | "some" | "many", "budget_band": "micro" | "low" | "mid", "flags": [string] (costly elements such as crowds, stunts, period, VFX, animals, water, vehicles)},
 "release": {"rent_price": integer, "own_price": integer, "why_price": string, "trailer_moments": [string] (3 specific moments that would cut into a strong trailer), "poster_idea": string, "cast_link_plan": string (how the cast and crew should promote it with their 4flieks links)}
}`;

function request(url, opts = {}, body = null) {
  const https = require('https');
  return new Promise((res, rej) => {
    const r = https.request(url, opts, x => {
      let d = ''; x.on('data', c => d += c);
      x.on('end', () => res({ status: x.statusCode, body: d }));
    });
    r.on('error', rej);
    r.setTimeout(840000, () => r.destroy(new Error('model request timed out')));
    if (body) r.write(body);
    r.end();
  });
}

async function analyse(scriptText, { title, writer, hint } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  let text = String(scriptText || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n');
  const truncated = text.length > MAX_SCRIPT_CHARS;
  if (truncated) text = text.slice(0, MAX_SCRIPT_CHARS);

  const user = `Screenplay title given by the filmmaker: ${title || '(none)'}` +
    (writer ? `\nWriter given by the filmmaker: ${writer}` : '') +
    (hint ? `\nThe filmmaker uploaded it as: ${hint}` : '') +
    (truncated ? '\nNote: the document was very long and has been cut off near the end.' : '') +
    `\n\n---\n${text}\n---\n\nWrite the coverage report. JSON only.`;

  const body = JSON.stringify({ model: MODEL, max_tokens: 16000, system: SYSTEM, messages: [{ role: 'user', content: user }] });
  const r = await request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
               'x-api-key': key, 'anthropic-version': '2023-06-01' }
  }, body);
  const d = JSON.parse(r.body || '{}');
  if (d.error) throw new Error(d.error.message || 'model error');
  const out = (d.content || []).map(b => b.text || '').join('');
  const a = out.indexOf('{'), b = out.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('The analysis came back empty. Try again.');
  let raw;
  try { raw = JSON.parse(out.slice(a, b + 1)); }
  catch { throw new Error(d.stop_reason === 'max_tokens' ? 'The analysis ran too long. Try again.' : 'The analysis could not be read. Try again.'); }
  const report = normalise(raw, { title, writer });
  report.meta = { model: MODEL, truncated, chars: text.length, usage: d.usage || null };
  return report;
}

/* ---------- make the model's answer safe to render ---------- */

const str = (v, max = 2000) => (v == null ? '' : String(v)).trim().slice(0, max);
const int = (v, lo, hi, dflt = null) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const arr = (v, max) => (Array.isArray(v) ? v : []).slice(0, max);
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);

function normalise(r, given = {}) {
  r = r && typeof r === 'object' ? r : {};
  const scoreKeys = ['concept', 'character', 'dialogue', 'structure', 'marketability'];
  const scores = {};
  scoreKeys.forEach(k => {
    const s = (r.scores || {})[k] || {};
    scores[k] = { score: int(s.score, 1, 10, 5), why: str(s.why, 300) };
  });

  let genres = arr(r.genres, 4).map(g => ({ genre: str(g && g.genre, 40), pct: int(g && g.pct, 0, 100, 0) }))
    .filter(g => g.genre && g.pct > 0);
  const total = genres.reduce((s, g) => s + g.pct, 0);
  if (total > 0 && total !== 100) {
    genres = genres.map(g => ({ ...g, pct: Math.round(g.pct * 100 / total) }));
    const diff = 100 - genres.reduce((s, g) => s + g.pct, 0);
    if (genres.length) genres[0].pct += diff;
  }

  const arc = arr(r.emotion_arc, 24).map((p, i) => ({
    n: i + 1,
    pages: str(p && p.pages, 20),
    moment: str(p && p.moment, 90),
    emotion: oneOf(String(p && p.emotion || '').toLowerCase(), EMOTIONS, 'tension'),
    intensity: int(p && p.intensity, 0, 10, 5),
    valence: int(p && p.valence, -5, 5, 0)
  }));

  const ad = r.adaptation && typeof r.adaptation === 'object' ? r.adaptation : null;
  const kind = oneOf((r.source || {}).kind, ['screenplay', 'treatment', 'prose', 'other'], 'screenplay');
  const st = r.structure || {};
  const fmt = r.format || {};
  const aud = r.audience || {};
  const pr = r.production || {};
  const rel = r.release || {};

  return {
    title: str(r.title, 120) || str(given.title, 120) || 'Untitled',
    source: { kind, note: str((r.source || {}).note, 200) },
    adaptation: kind === 'screenplay' || !ad ? null : {
      potential: oneOf(ad.potential, ['High', 'Medium', 'Low'], 'Medium'),
      best_format: oneOf(ad.best_format, ['short', 'feature', 'series'], 'short'),
      length: str(ad.length, 80),
      approach: str(ad.approach, 900),
      keep: arr(ad.keep, 6).map(x => str(x, 300)).filter(Boolean),
      cut: arr(ad.cut, 6).map(x => str(x, 300)).filter(Boolean),
      invent: arr(ad.invent, 6).map(x => str(x, 300)).filter(Boolean)
    },
    writer: str(r.writer, 120) || str(given.writer, 120) || null,
    format: {
      type: oneOf(fmt.type, ['short', 'feature', 'episode', 'other'], 'other'),
      pages: int(fmt.pages, 1, 400),
      est_runtime_mins: int(fmt.est_runtime_mins, 1, 400)
    },
    logline: str(r.logline, 400),
    synopsis: str(r.synopsis, 2000),
    verdict: {
      label: oneOf((r.verdict || {}).label, ['Strong', 'Promising', 'Needs work'], 'Promising'),
      summary: str((r.verdict || {}).summary, 700)
    },
    scores,
    genres,
    tone: str(r.tone, 120),
    themes: arr(r.themes, 5).map(t => str(t, 80)).filter(Boolean),
    emotion_arc: arc,
    structure: {
      acts: arr(st.acts, 5).map(a => ({ name: str(a && a.name, 40), pages: str(a && a.pages, 20), summary: str(a && a.summary, 500) })),
      inciting_incident: str(st.inciting_incident, 400),
      midpoint: str(st.midpoint, 400),
      climax: str(st.climax, 400),
      pacing: str(st.pacing, 600)
    },
    characters: arr(r.characters, 10).map(c => ({
      name: str(c && c.name, 60),
      role: oneOf(c && c.role, ['lead', 'supporting', 'minor'], 'supporting'),
      description: str(c && c.description, 400),
      arc: str(c && c.arc, 400),
      dialogue_share: int(c && c.dialogue_share, 0, 100, 0),
      casting: str(c && c.casting, 300)
    })).filter(c => c.name),
    languages: arr(r.languages, 8).map(l => str(l, 40)).filter(Boolean),
    audience: {
      primary: str(aud.primary, 300), secondary: str(aud.secondary, 300), why: str(aud.why, 600),
      markets: arr(aud.markets, 6).map(m => str(m, 60)).filter(Boolean), age_rating: str(aud.age_rating, 40)
    },
    comparables: arr(r.comparables, 5).map(c => ({ title: str(c && c.title, 100), year: int(c && c.year, 1900, 2100), why: str(c && c.why, 300) }))
      .filter(c => c.title),
    strengths: arr(r.strengths, 5).map(s => str(s, 400)).filter(Boolean),
    notes: arr(r.notes, 8).map(n => ({ area: str(n && n.area, 40), note: str(n && n.note, 600), where: str(n && n.where, 60) || null }))
      .filter(n => n.note),
    production: {
      speaking_roles: int(pr.speaking_roles, 0, 500),
      locations: int(pr.locations, 0, 500),
      night_scenes: oneOf(pr.night_scenes, ['few', 'some', 'many'], 'some'),
      budget_band: oneOf(pr.budget_band, ['micro', 'low', 'mid'], 'low'),
      flags: arr(pr.flags, 8).map(f => str(f, 60)).filter(Boolean)
    },
    release: {
      rent_price: int(rel.rent_price, 0, 200, 25),
      own_price: int(rel.own_price, 0, 500, 49),
      why_price: str(rel.why_price, 400),
      trailer_moments: arr(rel.trailer_moments, 4).map(t => str(t, 300)).filter(Boolean),
      poster_idea: str(rel.poster_idea, 400),
      cast_link_plan: str(rel.cast_link_plan, 600)
    }
  };
}

/* ---------- the pitch: persuasive, honest, one page ---------- */

const PITCH_SYSTEM = `You write one-page film pitches for funders, co-producers and festivals, for 4flieks, an African
independent film platform in South Africa. You get a script report (already written by a reader) and the
filmmaker's own details. Write persuasive, specific, confident copy in plain English: no hype words
("groundbreaking", "must-see"), no clichés, no exclamation marks.

Honesty rules:
- Use only facts in the report and the filmmaker's details. Never invent awards, budgets, figures, cast,
  partners, festival selections or attachments.
- Leave weaknesses out rather than misstate them; do not claim the opposite of the report.
- Comparable titles only from the report.

Return ONLY one JSON object, no fences:
{
 "headline": string (a tagline, max 12 words),
 "logline": string (max 45 words),
 "story": string (90-130 words),
 "why_this_film": string (50-80 words: what makes it distinctive),
 "why_now": string (30-60 words),
 "audience": string (30-60 words),
 "look_and_feel": string (30-60 words: tone, visual style, sound, performances),
 "production": string (30-60 words: scale, cast size, locations, budget band; practical and reassuring),
 "release": string (40-70 words: release on 4flieks with cast and crew links, plus sensible festival or partner routes),
 "comparables": [{"title": string, "year": integer or null, "note": string (max 15 words)}] (0-4),
 "key_facts": [{"label": string, "value": string}] (4-6 short facts, e.g. Format, Runtime, Language, Genre, Budget band, Stage)
}`;

async function writePitch(report, details = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  // Development notes and scores stay out: the pitch is for funders.
  const { notes, scores, meta, verdict, ...forPitch } = report || {};
  const user = `Script report (JSON):\n${JSON.stringify(forPitch)}\n\nFilmmaker's details:\n` +
    `Stage: ${details.stage || 'not given'}\nTeam: ${details.team || 'not given'}\nWhat they are looking for: ${details.ask || 'not given'}\n\nWrite the pitch. JSON only.`;
  const body = JSON.stringify({ model: MODEL, max_tokens: 3000, system: PITCH_SYSTEM, messages: [{ role: 'user', content: user }] });
  const r = await request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
               'x-api-key': key, 'anthropic-version': '2023-06-01' }
  }, body);
  const d = JSON.parse(r.body || '{}');
  if (d.error) throw new Error(d.error.message || 'model error');
  const out = (d.content || []).map(b => b.text || '').join('');
  const a = out.indexOf('{'), b = out.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('The pitch came back empty. Try again.');
  let raw;
  try { raw = JSON.parse(out.slice(a, b + 1)); } catch { throw new Error('The pitch could not be read. Try again.'); }
  return normalisePitch(raw);
}

function normalisePitch(p) {
  p = p && typeof p === 'object' ? p : {};
  return {
    headline: str(p.headline, 140),
    logline: str(p.logline, 400),
    story: str(p.story, 1200),
    why_this_film: str(p.why_this_film, 800),
    why_now: str(p.why_now, 600),
    audience: str(p.audience, 600),
    look_and_feel: str(p.look_and_feel, 600),
    production: str(p.production, 600),
    release: str(p.release, 700),
    comparables: arr(p.comparables, 4).map(c => ({ title: str(c && c.title, 100), year: int(c && c.year, 1900, 2100), note: str(c && c.note, 160) })).filter(c => c.title),
    key_facts: arr(p.key_facts, 6).map(f => ({ label: str(f && f.label, 30), value: str(f && f.value, 60) })).filter(f => f.label && f.value)
  };
}

/* ---------- cast match: characters to opted-in actors ---------- */

const MATCH_SYSTEM = `You are a casting director for 4flieks, an African independent film platform in South Africa.
You get the characters from a script report and a list of actors who have opted in to be suggested
for roles. For each character, suggest up to 3 actors who could genuinely play the part: playing age
must plausibly fit, and language fit matters. Actors may be anywhere in Africa: where they are (country,
city) is a secondary signal when the story's setting or languages point to a place, never a reason on its
own to leave someone out. Use each actor's 4flieks track record (films, people
their links brought in, sales) as a secondary signal only. Suggest fewer, or none, rather than a poor
fit. Never invent facts about an actor; use only what is in their profile.

Return ONLY JSON, no fences:
{"matches": [{"character": string (exactly as given), "picks": [{"id": string (an actor id from the list), "fit": "High" | "Medium", "why": string (max 25 words)}]}]}`;

async function matchCast(characters, candidates) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const user = `Characters:\n${JSON.stringify(characters)}\n\nActors who opted in:\n${JSON.stringify(candidates)}\n\nMatch them. JSON only.`;
  const body = JSON.stringify({ model: MODEL, max_tokens: 4000, system: MATCH_SYSTEM, messages: [{ role: 'user', content: user }] });
  const r = await request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
               'x-api-key': key, 'anthropic-version': '2023-06-01' }
  }, body);
  const d = JSON.parse(r.body || '{}');
  if (d.error) throw new Error(d.error.message || 'model error');
  const out = (d.content || []).map(b => b.text || '').join('');
  const a = out.indexOf('{'), b = out.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('The casting came back empty. Try again.');
  let raw;
  try { raw = JSON.parse(out.slice(a, b + 1)); } catch { throw new Error('The casting could not be read. Try again.'); }
  const ids = new Set(candidates.map(c => c.id));
  const names = new Set(characters.map(c => c.name));
  return arr(raw.matches, 12).map(m => ({
    character: str(m && m.character, 60),
    picks: arr(m && m.picks, 3)
      .filter(p => p && ids.has(String(p.id)))
      .map(p => ({ id: String(p.id), fit: oneOf(p.fit, ['High', 'Medium'], 'Medium'), why: str(p.why, 220) }))
  })).filter(m => names.has(m.character));
}

module.exports = { analyse, normalise, writePitch, normalisePitch, matchCast, EMOTIONS, MODEL };
