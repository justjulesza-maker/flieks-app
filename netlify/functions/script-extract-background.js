// Netlify BACKGROUND function — extracts characters + lines from an uploaded screenplay
// Background functions: return 202 immediately, run for up to 15 minutes
// The "-background" suffix in the filename tells Netlify to treat this as a background function
//
// Flow: client sends jobId + file → function writes status to Firebase → client polls Firebase
// Env vars required: ANTHROPIC_API_KEY, FIREBASE_DB_URL, FIREBASE_DB_SECRET

const pdfParse = require("pdf-parse");
const crypto = require("crypto");
const { extractCharacters } = require("../lib/coach-extract");

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

async function fbGet(path, firebaseUrl, firebaseSecret) {
  const res = await fetch(`${firebaseUrl}/${path}.json?auth=${firebaseSecret}`);
  return res.ok ? res.json() : null;
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
    const { title, writers, storyBy, fileBase64, fileName, jobId: clientJobId, owner, listed, canReplace } = JSON.parse(event.body);

    if (!title || !fileBase64 || !fileName || !clientJobId) {
      console.error("Missing required fields");
      return { statusCode: 400 };
    }

    jobId = clientJobId;
    filmSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "script";
    // Lab members' scripts are private: an unguessable slug, and never in the public picker.
    // A listed script also gets its own slug if the title is already someone else's,
    // so one upload can never overwrite another person's script. Admins may replace
    // the older scripts that were uploaded before owners were recorded.
    const taken = await fbGet(`flieks_coach_owner/${filmSlug}`, firebaseUrl, firebaseSecret);
    const legacy = !taken && await fbGet(`script_coach/films/${filmSlug}/meta/title`, firebaseUrl, firebaseSecret);
    if (listed === false || (taken && taken !== owner) || (legacy && !canReplace)) {
      filmSlug = `${filmSlug}-${crypto.randomBytes(8).toString("hex")}`;
    }
    if (owner) await fbWrite(`flieks_coach_owner/${filmSlug}`, owner, firebaseUrl, firebaseSecret);

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

    // ── 4. Read the script in parts (a feature is too long for one AI answer) ──
    let extracted;
    try {
      extracted = await extractCharacters(scriptText, title, {
        apiKey,
        onProgress: stage => fbPatch(`script_coach/jobs/${jobId}`, { stage }, firebaseUrl, firebaseSecret)
      });
    } catch (e) {
      console.error("Script Coach extraction failed:", e);
      await fbPatch(`script_coach/jobs/${jobId}`, {
        status: "error",
        error: e.status === 429 || e.status === 529
          ? "The AI is busy right now. Try again in a few minutes."
          : "The AI could not read part of this script. Try again; if it keeps failing, send us the file.",
        finishedAt: new Date().toISOString()
      }, firebaseUrl, firebaseSecret);
      return { statusCode: 200 };
    }
    console.log(`Script Coach: ${title} read in ${extracted.parts} part(s), ${extracted.characters.length} characters,`,
      `tokens in ${extracted.usage.input_tokens} out ${extracted.usage.output_tokens}${extracted.truncated ? `, ${extracted.truncated} part(s) cut short` : ""}`);

    if (!extracted.characters.length) {
      await fbPatch(`script_coach/jobs/${jobId}`, {
        status: "error",
        error: "No dialogue was found. Script Coach needs a screenplay with character names above the lines.",
        finishedAt: new Date().toISOString()
      }, firebaseUrl, firebaseSecret);
      return { statusCode: 200 };
    }

    // ── 5. Update stage ──
    await fbPatch(`script_coach/jobs/${jobId}`, {
      stage: "Building character profiles…"
    }, firebaseUrl, firebaseSecret);

    // ── 6. Write each character's data to Firebase ──
    await fbPatch(`script_coach/jobs/${jobId}`, {
      stage: "Saving to database…"
    }, firebaseUrl, firebaseSecret);

    const characterResults = [];

    for (const char of extracted.characters) {
      const charSlug = char.slug;

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
      if (listed !== false) await fbWrite(`script_coach/index/${indexKey}`, indexEntry, firebaseUrl, firebaseSecret);

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

    if (owner) {
      await fbWrite(`flieks_coach_by_user/${owner}/${jobId}`, {
        title, filmSlug, listed: listed !== false, characters: characterResults.length,
        finished_at: Date.now()
      }, firebaseUrl, firebaseSecret);
    }

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
