// Netlify serverless function — proxies line-quiz requests to Anthropic Messages API
// Env var required: ANTHROPIC_API_KEY
// Deploy alongside 4flieks.com: netlify/functions/line-coach.js

const crypto = require("crypto");
const ops = require("../lib/ops-core");

// Actors use this without an account, so it stays open, but bounded: only our
// own site, short inputs, a per-visitor hourly limit and a daily ceiling for
// everyone together. Each check is a small, cheap model call.
const PER_HOUR = parseInt(process.env.LINE_COACH_PER_HOUR || "60", 10);
const PER_DAY  = parseInt(process.env.LINE_COACH_PER_DAY || "3000", 10);

async function withinLimits(event) {
  const h = event.headers || {};
  const ip = String(h["x-nf-client-connection-ip"] || (h["x-forwarded-for"] || "").split(",")[0] || "unknown").trim();
  const who = crypto.createHash("sha256").update(ip + ":" + String(process.env.FIREBASE_DB_SECRET)).digest("hex").slice(0, 20);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const hour = now.toISOString().slice(0, 13).replace(/[-:T]/g, "");
  // Counted with the database's own increment, so bursts of requests can't slip past.
  const minePath = `flieks_ops/line_coach/${day}/by/${who}/${hour}`;
  if (!(await ops.takeSlot(minePath, PER_HOUR).catch(() => false))) return "You've checked a lot of lines this hour. Take a breather and try again soon.";
  if (!(await ops.takeSlot(`flieks_ops/line_coach/${day}/total`, PER_DAY).catch(() => false))) {
    await ops.dbIncrement(minePath, -1).catch(() => {});
    return "Line checking is busy today. Try again tomorrow.";
  }
  return null;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "https://4flieks.com",
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "API key not configured" }) };
  }

  try {
    const origin = String((event.headers || {}).origin || "");
    if (origin && !/^https:\/\/(www\.)?4flieks\.com$/.test(origin) && !/^https:\/\/[a-z0-9-]+--flieks-app\.netlify\.app$/.test(origin)) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Not allowed" }) };
    }

    let { correctLine, actorLine, emotion, character, filmTitle } = JSON.parse(event.body || "{}");

    if (!correctLine || !actorLine) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing correctLine or actorLine" }) };
    }
    const cut = (v, n) => String(v == null ? "" : v).slice(0, n);
    if (String(correctLine).length > 2000 || String(actorLine).length > 2000) {
      return { statusCode: 413, headers, body: JSON.stringify({ error: "That line is too long to check." }) };
    }
    correctLine = cut(correctLine, 2000); actorLine = cut(actorLine, 2000);
    emotion = cut(emotion, 300); character = cut(character, 120); filmTitle = cut(filmTitle, 120);

    const limited = await withinLimits(event);
    if (limited) return { statusCode: 429, headers, body: JSON.stringify({ error: limited }) };

    const systemPrompt = `You are a drama coach helping an actor learn their lines for the character "${character || "the role"}" in a script called "${filmTitle || "the production"}." Be encouraging, specific, and constructive. Respond in JSON only with keys: score (0-100), verdict (one of: "Nailed it!", "Very close!", "Getting there", "Keep working"), feedback (2-3 sentences of specific coaching), hint (one-sentence nudge toward the correct line without reproducing it in full). Never reproduce the full correct line in your response.`;

    const userPrompt = `Correct line: "${correctLine}"\nActor said: "${actorLine}"${emotion ? `\nEmotional direction: ${emotion}` : ""}\nScore and give feedback. JSON only.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      })
    });

    const data = await res.json();

    if (data.error) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: data.error.message || "Anthropic API error" }) };
    }

    const text = (data.content || []).map(b => b.text || "").join("");
    const clean = text.replace(/```json|```/g, "").trim();
    const feedback = JSON.parse(clean);

    return { statusCode: 200, headers, body: JSON.stringify(feedback) };

  } catch (err) {
    console.error("line-coach error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Failed to process request" }) };
  }
};
