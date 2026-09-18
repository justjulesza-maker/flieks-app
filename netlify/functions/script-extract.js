// Netlify serverless function — extracts characters + lines from an uploaded screenplay
// Uses pdf-parse (PDF) or mammoth (DOCX) for text extraction, Claude Sonnet for AI analysis
// Writes structured character data to Firebase Realtime DB
// Env vars required: ANTHROPIC_API_KEY, FIREBASE_DB_URL, FIREBASE_DB_SECRET

const pdfParse = require("pdf-parse");

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
  const firebaseUrl = process.env.FIREBASE_DB_URL;
  const firebaseSecret = process.env.FIREBASE_DB_SECRET;

  if (!apiKey || !firebaseUrl || !firebaseSecret) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Server not fully configured — check env vars" }) };
  }

  try {
    const { title, writers, storyBy, fileBase64, fileName } = JSON.parse(event.body);

    if (!title || !fileBase64 || !fileName) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing title, file, or filename" }) };
    }

    // ── 1. Extract text from uploaded file ──
    const fileBuffer = Buffer.from(fileBase64, "base64");
    let scriptText = "";

    const ext = fileName.toLowerCase().split(".").pop();
    if (ext === "pdf") {
      const pdfData = await pdfParse(fileBuffer);
      scriptText = pdfData.text;
    } else if (ext === "docx") {
      const mammoth = require("mammoth");
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      scriptText = result.value;
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Upload a PDF or DOCX file" }) };
    }

    if (!scriptText || scriptText.trim().length < 100) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Could not extract enough text from the file. Make sure it's a text-based PDF (not a scan)." }) };
    }

    // ── 2. Build slugs ──
    const filmSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const writersArr = writers ? writers.split(",").map(w => w.trim()).filter(Boolean) : [];
    const storyByArr = storyBy ? storyBy.split(",").map(w => w.trim()).filter(Boolean) : [];

    // ── 3. Call Claude to extract structured character/line data ──
    const systemPrompt = `You are a screenplay analysis AI for a line-learning tool used by actors. Given a screenplay's full text, extract every line of dialogue for every speaking character.

For each character, produce a JSON object:
{
  "name": "Full Character Name (as credited, with title/rank if used)",
  "slug": "lowercase-hyphenated",
  "scenes": ["Scene 1", "Scene 2"],
  "lines": [
    {
      "id": 1,
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
- Extract EVERY spoken line for EVERY character, including single words, V.O., O.S., and interrupted lines (em-dashes)
- Preserve exact text: profanity, slang, stammers, ellipses, deliberate misspellings
- The "cue" is what immediately precedes the line — the previous character's dialogue (with their name), or a stage direction in brackets
- The "beat" gives dramatic context an actor needs — what just happened, what's at stake, the emotional shift
- The "hook" must be genuinely useful for memorisation: break long speeches into KEYWORD CHUNKS (e.g., "GREETING / ACCUSATION / THREAT"), note repeated words, identify the line's emotional turn, count words for short punchy lines
- The "emotion" should read like a director's note — specific, evocative, actionable (e.g., "Cold fury barely contained" not just "angry")
- Scene labels should match the screenplay's scene headings/numbers
- Sequential IDs starting at 1 per character, chronological order
- If a character has a CONT'D speech broken across action lines, merge it into one line entry with the full combined dialogue

Return ONLY valid JSON (no markdown fences, no commentary):
{ "characters": [ ...array of character objects... ] }`;

    const userPrompt = `Here is the full screenplay for "${title}":\n\n---\n${scriptText}\n---\n\nExtract all characters and their lines. JSON only.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 16000,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      })
    });

    const data = await res.json();

    if (data.error) {
      console.error("Anthropic API error:", data.error);
      return { statusCode: 502, headers, body: JSON.stringify({ error: data.error.message || "AI extraction failed" }) };
    }

    const rawText = (data.content || []).map(b => b.text || "").join("");
    const cleanJson = rawText.replace(/```json|```/g, "").trim();

    let extracted;
    try {
      extracted = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.error("JSON parse failed:", parseErr.message, "\nRaw:", rawText.substring(0, 500));
      return { statusCode: 502, headers, body: JSON.stringify({ error: "AI returned invalid JSON — try again" }) };
    }

    if (!extracted.characters || !Array.isArray(extracted.characters)) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: "AI response missing characters array" }) };
    }

    // ── 4. Write each character's data to Firebase ──
    const characterResults = [];

    for (const char of extracted.characters) {
      const charSlug = char.slug || char.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

      const characterData = {
        filmTitle: title,
        character: char.name,
        writers: writersArr,
        storyBy: storyByArr,
        scenes: char.scenes || [...new Set(char.lines.map(l => {
          const parts = l.scene.split(" — ");
          return parts[0];
        }))],
        lines: char.lines
      };

      // Write character data
      const charPath = `script_coach/films/${filmSlug}/characters/${charSlug}`;
      const fbRes = await fetch(`${firebaseUrl}/${charPath}.json?auth=${firebaseSecret}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(characterData)
      });
      if (!fbRes.ok) {
        console.error(`Firebase write failed for ${charPath}:`, await fbRes.text());
      }

      // Write to global index (for the picker to discover)
      const indexKey = `${filmSlug}--${charSlug}`;
      const indexEntry = {
        title: title,
        character: char.name,
        filmSlug: filmSlug,
        charSlug: charSlug,
        lineCount: char.lines.length,
        createdAt: new Date().toISOString()
      };
      await fetch(`${firebaseUrl}/script_coach/index/${indexKey}.json?auth=${firebaseSecret}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(indexEntry)
      });

      characterResults.push({
        name: char.name,
        slug: charSlug,
        lineCount: char.lines.length,
        scenes: characterData.scenes,
        coachLink: `script-coach.html?film=${filmSlug}&character=${charSlug}`
      });
    }

    // ── 5. Write film meta ──
    const meta = {
      title,
      writers: writersArr,
      storyBy: storyByArr,
      characters: characterResults.map(c => ({ name: c.name, slug: c.slug, lineCount: c.lineCount })),
      createdAt: new Date().toISOString()
    };
    await fetch(`${firebaseUrl}/script_coach/films/${filmSlug}/meta.json?auth=${firebaseSecret}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(meta)
    });

    // ── 6. Return results ──
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        filmTitle: title,
        filmSlug,
        characters: characterResults
      })
    };

  } catch (err) {
    console.error("script-extract error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Failed to process script: " + (err.message || "Unknown error") })
    };
  }
};
