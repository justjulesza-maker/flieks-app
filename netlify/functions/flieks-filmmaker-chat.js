/**
 * flieks-filmmaker-chat — answers a filmmaker's question about the platform.
 *
 * Same pattern as line-coach.js: a thin proxy to the Anthropic Messages API,
 * no separate account or database needed. The system prompt carries
 * everything true about how 4flieks works for filmmakers (upload formats,
 * review, the 70/30 split, payouts, cast links) so answers stay accurate
 * without a filmmaker ever waiting on a human for the routine stuff.
 *
 * When signed in, the caller's own films (status, views, earnings) are
 * looked up and folded into the system prompt, so "why is my film not live
 * yet" can be answered specifically instead of generically.
 *
 * The model is asked to say plainly when a question is outside what it
 * knows or needs a person (anything about a specific payout, a rejected
 * film's reasoning, a dispute, a bug) and to set escalate:true — the
 * widget then offers to open a support ticket instead of guessing.
 *
 * Env var required: ANTHROPIC_API_KEY (already set for line-coach.js)
 * POST { message, history?, token? } -> { reply, escalate }
 */
const https = require('https');

const DB      = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET  = process.env.FIREBASE_DB_SECRET;
const API_KEY = process.env.FIREBASE_API_KEY;

function request(url, opts = {}, body = null) {
  return new Promise((res, rej) => {
    const r = https.request(url, opts, x => {
      let d = ''; x.on('data', c => d += c);
      x.on('end', () => res({ status: x.statusCode, body: d }));
    });
    r.on('error', rej);
    if (body) r.write(body);
    r.end();
  });
}

const dbGet = async p => JSON.parse((await request(`${DB}/${p}.json?auth=${SECRET}`)).body || 'null');

async function whoIs(token) {
  if (!token || !API_KEY) return null;
  try {
    const b = JSON.stringify({ idToken: token });
    const r = await request(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
    }, b);
    const d = JSON.parse(r.body || '{}');
    return (d.users && d.users[0]) || null;
  } catch { return null; }
}

const KNOWLEDGE = `
You are the 4flieks filmmaker support assistant, embedded in the filmmaker portal at
4flieks.com/filmmaker. You help African filmmakers who have already signed up understand
how the platform works and unblock themselves without waiting on a person.

FACTS ABOUT HOW 4FLIEKS WORKS FOR FILMMAKERS — treat all of this as true and current:

- Films are 10-15 minute short films, any African language, any genre.
- The release flow: filmmaker uploads film + poster + trailer -> admin reviews it ->
  admin approves and takes it live -> filmmaker adds cast links -> cast share their
  links -> viewers pay -> filmmaker sees earnings -> filmmaker requests a payout.
- Upload requirements: film file MP4 or MOV; trailer MP4 or MOV, under 200MB,
  2-3 minutes recommended; poster is a 9:16 portrait image (JPG or PNG).
- After upload, a film sits in the review queue until an admin approves it. Filmmakers
  are told to expect 1-2 business days. If it has been longer than that, it is worth a
  support ticket rather than more waiting.
- A rejected film shows the reason on the filmmaker's dashboard next to the film.
- Filmmakers keep 70% of net revenue and keep their copyright. The arrangement is
  non-exclusive — a filmmaker can release the same film elsewhere too.
- Viewer pricing: Rental R25 (48 hours, clock starts at first play, not at purchase),
  Own R49 (permanent), Gift R49 (a one-time code for someone else). Prices are
  VAT-inclusive; the 70/30 split applies to the ex-VAT amount.
- Cast and crew: each person gets their own tracked link and QR code. Sales through
  that link are attributed to them. What a filmmaker pays their cast (typically
  15-20% of what that person brought in) is agreed and paid directly between the
  filmmaker and their cast — 4flieks measures it, it does not process that payment.
- Payouts: requested from the filmmaker portal once there is a balance. Paid by EFT
  to the bank details on file. There is a minimum payout amount.
- Payments are processed by Yoco (card, Instant EFT, and other local methods).
- Streaming only — there is no download, by design, so a film cannot be passed
  around as a file.
- Filmmakers get a shareable release report for funders and festivals.
- 4flieks is expanding beyond South Africa to the rest of Africa.

WHAT YOU DO NOT KNOW AND MUST NOT GUESS:
- The specific reason a specific film was rejected beyond what their dashboard says.
- Anything about a specific payout's timing, amount, or a banking problem.
- Bugs, outages, or anything that sounds like something is broken on the site right now.
- Anything about a dispute, a legal question, or a contract question.
- Anything not covered in the facts above.

For anything in that second list, or anything you are not confident about, say so
plainly, do not invent an answer, and set escalate to true so the person can reach
a human. Be warm, direct, and brief — most filmmakers are asking on a phone. Do not
pad the answer with disclaimers when you do know the answer.

Respond in JSON only, with exactly these keys:
{"reply": "your answer, 1-4 short sentences", "escalate": true or false}
`.trim();

const reply = (code, obj) => ({
  statusCode: code,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  },
  body: JSON.stringify(obj)
});

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return reply(204, {});
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return reply(500, { reply: 'The assistant is not set up yet — please use the form below.', escalate: true });

  try {
    const { message, history, token } = JSON.parse(event.body || '{}');
    const question = String(message || '').trim().slice(0, 800);
    if (!question) return reply(400, { reply: 'What did you want to ask?', escalate: false });

    let systemPrompt = KNOWLEDGE;

    // Fold in this filmmaker's own films, when signed in, so a question like
    // "why is my film not live yet" can be answered specifically.
    const user = await whoIs(token);
    if (user) {
      try {
        const films = await dbGet('flieks_films');
        const mine = Object.entries(films || {})
          .filter(([, f]) => f && f.filmmaker_uid === user.localId)
          .map(([id, f]) => ({
            title: f.title || id,
            status: f.status || (f.live ? 'live' : 'draft'),
            rejection_reason: f.rejection_reason || null,
            views: f.views || 0
          }));
        if (mine.length) {
          systemPrompt += `\n\nTHIS FILMMAKER'S OWN FILMS (use this to answer specifically, do not read it out verbatim unless asked):\n${JSON.stringify(mine)}`;
        } else {
          systemPrompt += `\n\nTHIS FILMMAKER HAS NOT UPLOADED A FILM YET.`;
        }
      } catch { /* best effort — answer generically if this lookup fails */ }
    }

    const messages = Array.isArray(history)
      ? history.slice(-6).filter(m => m && m.role && m.content).map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: String(m.content).slice(0, 800)
        }))
      : [];
    messages.push({ role: 'user', content: question });

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: systemPrompt,
        messages
      })
    });

    const data = await res.json();
    if (data.error) {
      console.error('filmmaker-chat: anthropic error', data.error);
      return reply(200, { reply: 'Something went wrong on my end — try the form below and we will get straight back to you.', escalate: true });
    }

    const text = (data.content || []).map(b => b.text || '').join('');
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      parsed = { reply: text.trim() || "I couldn't quite answer that — try the form below.", escalate: true };
    }

    return reply(200, {
      reply: String(parsed.reply || '').slice(0, 1200),
      escalate: !!parsed.escalate
    });

  } catch (e) {
    console.error('filmmaker-chat error:', e);
    return reply(500, { reply: 'Could not reach the assistant — try the form below.', escalate: true });
  }
};
