// Netlify serverless function — proxies line-quiz requests to Anthropic Messages API
// Env var required: ANTHROPIC_API_KEY
// Deploy alongside 4flieks.com: netlify/functions/line-coach.js

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
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
    const { correctLine, actorLine, emotion, character, filmTitle } = JSON.parse(event.body);

    if (!correctLine || !actorLine) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing correctLine or actorLine" }) };
    }

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
