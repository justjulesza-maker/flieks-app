/**
 * coach-extract — pulls every character's lines out of a screenplay for Script Coach.
 *
 * A feature-length script has hundreds of lines, and every line gets a beat, cue,
 * memory hook and delivery note, so one AI answer for the whole script is too long:
 * it ran past the 5-minute limit on a single request ("fetch failed") and past the
 * output limit. So the script is split into parts at scene headings, each part is
 * read by its own streamed AI call (a few in parallel), and the characters are
 * merged back together in script order.
 */

const MODEL = process.env.SCRIPT_COACH_MODEL || 'claude-sonnet-5';
const PART_CHARS = parseInt(process.env.SCRIPT_COACH_PART_CHARS || '14000', 10);  // ~8–10 screenplay pages
const PARALLEL = parseInt(process.env.SCRIPT_COACH_PARALLEL || '6', 10);
const CONTEXT_CHARS = 1500;   // the end of the previous part, so the first cue in a part is right

const SYSTEM = `You are a screenplay analysis AI for a line-learning tool used by actors. You get ONE PART of a
screenplay's text (plus, for context only, the end of the part before it). Extract every line of dialogue
spoken in THIS PART, for every speaking character in it.

For each character, produce a JSON object:
{
  "cue_name": "The name exactly as it appears in the character cue above their dialogue, without (V.O.), (O.S.) or (CONT'D)",
  "name": "Full Character Name (as credited, with title/rank if used)",
  "scenes": ["Scene 1", "Scene 2"],
  "lines": [
    {
      "scene": "Scene X — Brief Description of This Moment",
      "beat": "What's happening dramatically — the context an actor needs",
      "cue": "The line, action, or stage direction immediately before this dialogue",
      "line": "The exact dialogue as written",
      "hook": "A practical memory aid — keyword chunks for long lines, word patterns, anchoring phrases",
      "emotion": "Specific acting/delivery direction — not generic, but how this moment should feel"
    }
  ]
}

Rules:
- Extract EVERY spoken line in this part for EVERY character, including single words, V.O., O.S., and interrupted lines (em-dashes)
- Do NOT extract dialogue from the context before the part; use it only to write the first cues
- Preserve exact text: profanity, slang, stammers, ellipses, deliberate misspellings, lines in any language
- The "cue" is what immediately precedes the line — the previous character's dialogue (with their name), or a stage direction in brackets
- The "beat" gives dramatic context an actor needs — what just happened, what's at stake, the emotional shift
- The "hook" must be genuinely useful for memorisation: break long speeches into KEYWORD CHUNKS (e.g., "GREETING / ACCUSATION / THREAT"), note repeated words, identify the line's emotional turn, count words for short punchy lines
- The "emotion" should read like a director's note — specific, evocative, actionable (e.g., "Cold fury barely contained" not just "angry")
- Keep "beat", "hook" and "emotion" to one short sentence each
- Scene labels should match the screenplay's scene headings/numbers
- Lines in chronological order within each character
- If a character has a CONT'D speech broken across action lines, merge it into one line entry with the full combined dialogue

Return ONLY valid JSON (no markdown fences, no commentary):
{ "characters": [ ...array of character objects... ] }`;

/* ---------- splitting ---------- */

const HEADING = /^[ \t]*(?:\d+[A-Z]?[.)]?[ \t]+)?(?:INT\.|EXT\.|INT\/EXT|EXT\/INT|I\/E)/m;

/** Split a screenplay into parts of about `size` characters, breaking at scene headings. */
function splitScript(text, size = PART_CHARS) {
  const t = String(text || '').replace(/\r\n?/g, '\n');
  if (t.length <= size * 1.3) return [t];
  // Scene starts: every line that looks like a scene heading.
  const starts = [];
  const re = new RegExp(HEADING.source, 'gm');
  let m;
  while ((m = re.exec(t))) { starts.push(m.index); if (re.lastIndex === m.index) re.lastIndex++; }
  let blocks = [];
  if (starts.length >= 2) {
    if (starts[0] > 0) blocks.push(t.slice(0, starts[0]));
    starts.forEach((s, i) => blocks.push(t.slice(s, starts[i + 1] ?? t.length)));
  } else {
    blocks = t.split(/\n{2,}/).map(b => b + '\n\n');   // no headings: paragraphs
  }
  // A single huge scene is cut at paragraph breaks.
  const pieces = [];
  for (const b of blocks) {
    if (b.length <= size * 1.5) { pieces.push(b); continue; }
    let cur = '';
    for (const p of b.split(/(?<=\n)\s*\n/)) {
      if (cur && cur.length + p.length > size) { pieces.push(cur); cur = ''; }
      cur += p;
    }
    if (cur) pieces.push(cur);
  }
  // Pack pieces into parts.
  const parts = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && cur.length + p.length > size) { parts.push(cur); cur = ''; }
    cur += p;
  }
  if (cur.trim()) {
    // A tiny last part joins the one before it.
    if (parts.length && cur.length < size * 0.3) parts[parts.length - 1] += cur;
    else parts.push(cur);
  }
  return parts;
}

/* ---------- the AI call, streamed ---------- */

async function streamClaude({ system, user, maxTokens, apiKey, fetchImpl = fetch }) {
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, stream: true, system, messages: [{ role: 'user', content: user }] })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = `AI error ${res.status}`;
    try { msg = JSON.parse(body).error.message || msg; } catch {}
    const err = new Error(msg); err.status = res.status; throw err;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', stopReason = '', usage = { input_tokens: 0, output_tokens: 0 };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') text += ev.delta.text;
      else if (ev.type === 'message_start' && ev.message && ev.message.usage) usage.input_tokens = ev.message.usage.input_tokens || 0;
      else if (ev.type === 'message_delta') {
        if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage && ev.usage.output_tokens) usage.output_tokens = ev.usage.output_tokens;
      } else if (ev.type === 'error') {
        const err = new Error((ev.error && ev.error.message) || 'AI stream error'); err.status = 529; throw err;
      }
    }
  }
  return { text, stopReason, usage };
}

/* ---------- JSON, with repair for a cut-off answer ---------- */

function parseCharacters(raw) {
  let s = String(raw || '').replace(/```json|```/g, '').trim();
  const first = s.indexOf('{');
  if (first > 0) s = s.slice(first);
  try { return JSON.parse(s); } catch (e) { /* repair below */ }
  const last = s.lastIndexOf('}');
  if (last <= 0) throw new Error('no JSON');
  let r = s.slice(0, last + 1);
  let braces = 0, brackets = 0, inStr = false, esc = false;
  for (const c of r) {
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') braces++; else if (c === '}') braces--;
    else if (c === '[') brackets++; else if (c === ']') brackets--;
  }
  r = r.replace(/,\s*$/, '');
  r += ']'.repeat(Math.max(0, brackets)) + '}'.repeat(Math.max(0, braces));
  return JSON.parse(r);
}

/* ---------- merging parts ---------- */

const keyOf = n => String(n || '').toUpperCase()
  .replace(/\((?:V\.?O\.?|O\.?S\.?|O\.?C\.?|CONT'?D|CONT’D|CONTINUED|PRE-?LAP|ON PHONE|INTO PHONE|FILTERED)\)/g, '')
  .replace(/\([^)]*\)/g, '').replace(/[^A-Z0-9À-Ý' -]+/g, ' ').replace(/\s+/g, ' ').trim();
const slugOf = n => String(n || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'character';
const titleCase = n => String(n || '').toLowerCase().replace(/(^|[\s'-])([a-zà-ý])/g, (m, a, b) => a + b.toUpperCase());

/** results: one { characters } per part, in script order. */
function mergeParts(results) {
  const byKey = new Map();
  results.forEach(res => (res && Array.isArray(res.characters) ? res.characters : []).forEach(c => {
    if (!c || !Array.isArray(c.lines)) return;
    const lines = c.lines.filter(l => l && typeof l.line === 'string' && l.line.trim());
    if (!lines.length) return;
    const key = keyOf(c.cue_name || c.name);
    if (!key) return;
    let e = byKey.get(key);
    if (!e) {
      // Prefer the credited name; an ALL-CAPS cue becomes Title Case.
      const nm = String(c.name || c.cue_name || key).trim();
      e = { name: nm === nm.toUpperCase() ? titleCase(nm) : nm, scenes: [], lines: [] };
      byKey.set(key, e);
    }
    (Array.isArray(c.scenes) ? c.scenes : []).forEach(s => { if (s && !e.scenes.includes(s)) e.scenes.push(s); });
    lines.forEach(l => e.lines.push(l));
  }));
  const used = new Set();
  const out = [...byKey.values()].map(e => {
    let slug = slugOf(e.name), n = 2;
    while (used.has(slug)) slug = `${slugOf(e.name)}-${n++}`;
    used.add(slug);
    const lines = e.lines.map((l, i) => ({
      id: i + 1, scene: String(l.scene || ''), beat: String(l.beat || ''), cue: String(l.cue || ''),
      line: String(l.line), hook: String(l.hook || ''), emotion: String(l.emotion || '')
    }));
    const scenes = e.scenes.length ? e.scenes : [...new Set(lines.map(l => l.scene.split(' — ')[0]).filter(Boolean))];
    return { name: e.name, slug, scenes, lines };
  });
  // Biggest parts first, as the picker shows them.
  return out.sort((a, b) => b.lines.length - a.lines.length);
}

/* ---------- the whole job ---------- */

async function extractCharacters(scriptText, title, { apiKey, onProgress = () => {}, fetchImpl, partChars } = {}) {
  const parts = splitScript(scriptText, partChars || PART_CHARS);
  const results = new Array(parts.length);
  const usage = { input_tokens: 0, output_tokens: 0 };
  let done = 0, truncated = 0;
  await onProgress(parts.length > 1 ? `AI is reading the screenplay in ${parts.length} parts…` : 'AI is reading the screenplay…');

  const readPart = async i => {
    const before = i > 0 ? parts[i - 1].slice(-CONTEXT_CHARS) : '';
    const user = `Screenplay: "${title}" — part ${i + 1} of ${parts.length}.\n\n` +
      (before ? `CONTEXT ONLY (end of the previous part; do not extract its dialogue):\n---\n${before}\n---\n\n` : '') +
      `THE PART TO EXTRACT:\n---\n${parts[i]}\n---\n\nExtract all characters and their lines in this part. JSON only.`;
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await streamClaude({ system: SYSTEM, user, maxTokens: 32000, apiKey, fetchImpl });
        usage.input_tokens += r.usage.input_tokens; usage.output_tokens += r.usage.output_tokens;
        if (r.stopReason === 'max_tokens') truncated++;
        const parsed = parseCharacters(r.text);
        if (!parsed || !Array.isArray(parsed.characters)) throw new Error('no characters');
        return parsed;
      } catch (e) {
        lastErr = e;
        if (e.status === 400 || e.status === 401 || e.status === 403) break;   // retrying won't help
        await new Promise(r => setTimeout(r, e.status === 429 || e.status === 529 ? 8000 : 2000));
      }
    }
    throw lastErr;
  };

  let next = 0;
  const worker = async () => {
    while (next < parts.length) {
      const i = next++;
      results[i] = await readPart(i);
      done++;
      if (parts.length > 1) await onProgress(`AI is reading the screenplay: ${done} of ${parts.length} parts done…`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, parts.length) }, worker));
  return { characters: mergeParts(results), parts: parts.length, truncated, usage };
}

module.exports = { extractCharacters, splitScript, mergeParts, parseCharacters, streamClaude, keyOf, SYSTEM };
