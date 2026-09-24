// Netlify BACKGROUND function — extracts characters + lines from an uploaded screenplay
// Background functions: return 202 immediately, run for up to 15 minutes
// The "-background" suffix in the filename tells Netlify to treat this as a background function
//
// Flow: client sends jobId + file → function writes status to Firebase → client polls Firebase
// Env vars required: ANTHROPIC_API_KEY, FIREBASE_DB_URL, FIREBASE_DB_SECRET

const pdfParse = require("pdf-parse");
const crypto = require("crypto");

// Only script-coach-start (which checks who is asking) may start a job.
const coachSecret = () => crypto.createHash("sha256").update(String(process.env.FIREBASE_DB_SECRET) + ":script-coach").digest("hex");

// ── Firebase helper ──
async function fbWrite(path, data, firebaseUrl, firebaseSecret) {
  const res = await fetch(`${firebaseUrl}/${path}.json?auth=${firebaseSecret}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!res.ok) {
    console.error(`Firebase write failed for ${path}:`, await res.text());
  }
  return res;
}

async function fbPatch(path, data, firebaseUrl, firebaseSecret) {
  const res = await fetch(`${firebaseUrl}/${path}.json?auth=${firebaseSecret}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!res.ok) {
    console.error(`Firebase patch failed for ${path}:`, await res.text());
  }
  return res;
}

exports.handler = async (event) => {
  const given = String((event.headers || {})["x-job-secret"] || "");
  const want = coachSecret();
  if (given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) {
    console.warn("script-extract-background: refused, not called by script-coach-start");
    return { statusCode: 403 };
  }

  // Background functions ignore the return value — Netlify sends 202 immediately.
  // All results go to Firebase so the client can poll.

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const firebaseUrl = process.env.FIREBASE_DB_URL;
  const firebaseSecret = process.env.FIREBASE_DB_SECRET;

  if (!apiKey || !firebaseUrl || !firebaseSecret) {
    console.error("Missing env vars");
    return { statusCode: 500 };
  }

  let jobId, filmSlug;

  try {
    const { title, writers, storyBy, fileBase64, fileName, jobId: clientJobId } = JSON.parse(event.body);

    if (!title || !fileBase64 || !fileName || !clientJobId) {
      console.error("Missing required fields");
      return { statusCode: 400 };
    }

    jobId = clientJobId;
    filmSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

    // Mark job as processing
    await fbWrite(`script_coach/jobs/${jobId}`, {
      status: "processing",
      filmTitle: title,
      filmSlug,
      stage: "Extracting text from file…",
      startedAt: new Date().toISOString()
    }, firebaseUrl, firebaseSecret);

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
      await fbPatch(`script_coach/jobs/${jobId}`, {
        status: "error",
        error: "Upload a PDF or DOCX file",
        finishedAt: new Date().toISOString()
      }, firebaseUrl, firebaseSecret);
      return { statusCode: 200 };
    }

    if (!scriptText || scriptText.trim().length < 100) {
      await fbPatch(`script_coach/jobs/${jobId}`, {
        status: "error",
        error: "Could not extract enough text from the file. Make sure it's a text-based PDF (not a scan).",
        finishedAt: new Date().toISOString()
      }, firebaseUrl, firebaseSecret);
      return { statusCode: 200 };
    }

    // ── 2. Update stage ──
    await fbPatch(`script_coach/jobs/${jobId}`, {
      stage: "AI is reading the screenplay…"
    }, firebaseUrl, firebaseSecret);

    // ── 3. Build slugs ──
    const writersArr = writers ? writers.split(",").map(w => w.trim()).filter(Boolean) : [];
    const storyByArr = storyBy ? storyBy.split(",").map(w => w.trim()).filter(Boolean) : [];

    // ── 4. Call Claude to extract structured character/line data ──
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
        max_tokens: 64000,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      })
    });

    const data = await res.json();

    if (data.error) {
      console.error("Anthropic API error:", data.error);
      await fbPatch(`script_coach/jobs/${jobId}`, {
        status: "error",
        error: data.error.message || "AI extraction failed",
        finishedAt: new Date().toISOString()
      }, firebaseUrl, firebaseSecret);
      return { statusCode: 200 };
    }

    // ── 5. Update stage ──
    await fbPatch(`script_coach/jobs/${jobId}`, {
      stage: "Building character profiles…"
    }, firebaseUrl, firebaseSecret);

    const rawText = (data.content || []).map(b => b.text || "").join("");
    const stopReason = data.stop_reason || "";

    // Check if output was truncated (hit max_tokens)
    if (stopReason === "max_tokens") {
      console.error("Output truncated — hit max_tokens. Raw length:", rawText.length);
    }

    // Robust JSON extraction: strip fences, find the outermost { ... }
    let cleanJson = rawText.replace(/```json|```/g, "").trim();

    // Find the first { and try to extract the JSON object
    const firstBrace = cleanJson.indexOf("{");
    if (firstBrace > 0) {
      cleanJson = cleanJson.substring(firstBrace);
    }

    // If truncated, try to repair: close any open arrays/objects
    let extracted;
    try {
      extracted = JSON.parse(cleanJson);
    } catch (parseErr) {
      // Attempt repair for truncated JSON: find last complete character entry
      console.log("Initial parse failed, attempting truncation repair…");
      try {
        // Find the last complete } ] pattern and close the structure
        // Look for the last "}," or "}" that ends a character block
        let repaired = cleanJson;

        // Remove any trailing incomplete object/array
        // Find last complete line entry (ends with })
        const lastCompleteObj = repaired.lastIndexOf("}");
        if (lastCompleteObj > 0) {
          repaired = repaired.substring(0, lastCompleteObj + 1);

          // Count open brackets to figure out what needs closing
          let openBraces = 0, openBrackets = 0;
          let inString = false, escaped = false;
          for (let i = 0; i < repaired.length; i++) {
            const c = repaired[i];
            if (escaped) { escaped = false; continue; }
            if (c === "\\") { escaped = true; continue; }
            if (c === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (c === "{") openBraces++;
            if (c === "}") openBraces--;
            if (c === "[") openBrackets++;
            if (c === "]") openBrackets--;
          }

          // Remove trailing comma if present
          repaired = repaired.replace(/,\s*$/, "");

          // Close open brackets/braces
          for (let i = 0; i < openBrackets; i++) repaired += "]";
          for (let i = 0; i < openBraces; i++) repaired += "}";

          extracted = JSON.parse(repaired);
          console.log("Truncation repair succeeded");
        } else {
          throw parseErr;
        }
      } catch (repairErr) {
        console.error("JSON parse + repair both failed:", parseErr.message, "\nRaw start:", rawText.substring(0, 500), "\nRaw end:", rawText.substring(rawText.length - 500));
        await fbPatch(`script_coach/jobs/${jobId}`, {
          status: "error",
          error: "AI returned invalid JSON — try uploading again",
          finishedAt: new Date().toISOString()
        }, firebaseUrl, firebaseSecret);
        return { statusCode: 200 };
      }
    }

    if (!extracted.characters || !Array.isArray(extracted.characters)) {
      await fbPatch(`script_coach/jobs/${jobId}`, {
        status: "error",
        error: "AI response missing characters array",
        finishedAt: new Date().toISOString()
      }, firebaseUrl, firebaseSecret);
      return { statusCode: 200 };
    }

    // ── 6. Write each character's data to Firebase ──
    await fbPatch(`script_coach/jobs/${jobId}`, {
      stage: "Saving to database…"
    }, firebaseUrl, firebaseSecret);

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
      await fbWrite(charPath, characterData, firebaseUrl, firebaseSecret);

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
      await fbWrite(`script_coach/index/${indexKey}`, indexEntry, firebaseUrl, firebaseSecret);

      characterResults.push({
        name: char.name,
        slug: charSlug,
        lineCount: char.lines.length,
        scenes: characterData.scenes,
        coachLink: `script-coach.html?film=${filmSlug}&character=${charSlug}`
      });
    }

    // ── 7. Write film meta ──
    const meta = {
      title,
      writers: writersArr,
      storyBy: storyByArr,
      characters: characterResults.map(c => ({ name: c.name, slug: c.slug, lineCount: c.lineCount })),
      createdAt: new Date().toISOString()
    };
    await fbWrite(`script_coach/films/${filmSlug}/meta`, meta, firebaseUrl, firebaseSecret);

    // ── 8. Save full script text (for "Read Full Script" feature) ──
    await fbWrite(`script_coach/films/${filmSlug}/fullScript`, scriptText, firebaseUrl, firebaseSecret);

    // ── 9. Mark job complete with results ──
    await fbPatch(`script_coach/jobs/${jobId}`, {
      status: "complete",
      stage: "Done!",
      filmTitle: title,
      filmSlug,
      characters: characterResults,
      finishedAt: new Date().toISOString()
    }, firebaseUrl, firebaseSecret);

    console.log(`✅ Script extraction complete: ${title} — ${characterResults.length} characters`);
    return { statusCode: 200 };

  } catch (err) {
    console.error("script-extract-background error:", err);

    // Try to mark the job as failed if we have enough context
    if (jobId) {
      try {
        await fbPatch(`script_coach/jobs/${jobId}`, {
          status: "error",
          error: "Failed to process script: " + (err.message || "Unknown error"),
          finishedAt: new Date().toISOString()
        }, firebaseUrl, firebaseSecret);
      } catch (fbErr) {
        console.error("Failed to write error to Firebase:", fbErr);
      }
    }

    return { statusCode: 200 };
  }
};
