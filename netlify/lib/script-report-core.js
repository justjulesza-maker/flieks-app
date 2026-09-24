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

const SYSTEM = `You are a senior script reader writing coverage for an African independent film platform, 4flieks
(4flieks.com), based in South Africa. Filmmakers upload a screenplay and receive your report; many will
share it with funders. Be honest, specific and useful: praise what works, name what doesn't, and point to
pages or scenes. Write in plain, warm, professional English. South African context matters: languages,
places, audiences and the realities of low-budget production here.

Rules:
- Only use what is in the script. Never invent facts about the writer, the production or real people.
- Never name real actors for casting; describe the kind of performer instead.
- Comparable titles must be real films or series you are confident exist. Prefer African and South
  African titles where they genuinely fit. If unsure, give fewer.
- If the text looks garbled, incomplete or is not a screenplay, say so plainly in the verdict and keep
  everything else short.
- 4flieks pricing: shorts usually rent for R25 and sell for R49; features up to about R35 rent and R59 own.
- Return ONLY one JSON object, no markdown fences, no commentary, exactly this shape:

{
 "title": string,
 "writer": string or null (only if printed on the script),
 "format": {"type": "short" | "feature" | "episode" | "other", "pages": integer or null, "est_runtime_mins": integer or null},
 "logline": string (max 45 words),
 "synopsis": string (120-200 words, spoilers allowed),
 "verdict": {"label": "Strong" | "Promising" | "Needs work", "summary": string (2-3 sentences)},
 "scores": {"concept": {"score": 1-10, "why": string}, "character": {...}, "dialogue": {...}, "structure": {...}, "marketability": {...}},
 "genres": [{"genre": string, "pct": integer}] (1-4 items, pct sums to 100),
 "tone": string (a short phrase),
 "themes": [string] (3-5),
 "emotion_arc": [{"n": integer from 1, "pages": string, "moment": string (max 10 words), "emotion": one of ${EMOTIONS.join(' | ')}, "intensity": 0-10, "valence": -5 to 5}] (10-20 points in story order, covering the whole script),
 "structure": {"acts": [{"name": string, "pages": string, "summary": string}], "inciting_incident": string, "midpoint": string, "climax": string, "pacing": string},
 "characters": [{"name": string, "role": "lead" | "supporting" | "minor", "description": string, "arc": string, "dialogue_share": integer (approx % of all dialogue lines), "casting": string (age range, qualities, languages; no real names)}] (up to 10, most important first),
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

async function analyse(scriptText, { title, writer } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  let text = String(scriptText || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n');
  const truncated = text.length > MAX_SCRIPT_CHARS;
  if (truncated) text = text.slice(0, MAX_SCRIPT_CHARS);

  const user = `Screenplay title given by the filmmaker: ${title || '(none)'}` +
    (writer ? `\nWriter given by the filmmaker: ${writer}` : '') +
    (truncated ? '\nNote: the script was very long and has been cut off near the end.' : '') +
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

  const st = r.structure || {};
  const fmt = r.format || {};
  const aud = r.audience || {};
  const pr = r.production || {};
  const rel = r.release || {};

  return {
    title: str(r.title, 120) || str(given.title, 120) || 'Untitled',
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

module.exports = { analyse, normalise, EMOTIONS, MODEL };
