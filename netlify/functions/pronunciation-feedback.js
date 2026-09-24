const ALLOWED_STATUSES = new Set(["match", "try_again", "unclear"]);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify(body)
  };
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function stripCodeFences(text) {
  return String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function normalizeForCheck(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}' ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function focusIsFromTarget(focus, targetPhrase) {
  if (!focus) return true;
  const f = normalizeForCheck(focus);
  const t = normalizeForCheck(targetPhrase);
  return !!f && t.includes(f);
}

function validateFeedback(data, targetPhrase) {
  if (!data || typeof data !== "object") return null;

  const status = cleanText(data.status, 20);
  const message = cleanText(data.message, 160);
  let focus = cleanText(data.focus, 60);

  if (!ALLOWED_STATUSES.has(status)) return null;
  if (!message) return null;

  // Keep the learner-facing feedback plain and safe.
  if (/[<>{}\[\]\\|`~^]|https?:|data:|javascript:/i.test(message)) return null;

  if (/\d|%|\bscores?\b|\bstars?\b|\bgrades?\b|\blevels?\b|\bpoints?\b|\bmarks?\b|\bbadges?\b/i.test(message)) {
    return null;
  }

  if (!focusIsFromTarget(focus, targetPhrase)) {
    focus = "";
  }

  return { status, message, focus };
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders(),
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method Not Allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return json(500, { error: "AI service is not configured." });
  }

  try {
    let body;

    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON." });
    }

    const targetPhrase = cleanText(body.targetPhrase, 180);
    const recognisedText = cleanText(body.recognisedText, 300);

    if (!targetPhrase || !recognisedText) {
      return json(400, { error: "Missing targetPhrase or recognisedText." });
    }

    const prompt = `You are a careful British-English pronunciation practice assistant for adult A1-A2 learners.

You receive:
- TARGET PHRASE: the exact model sentence.
- RECOGNISED TEXT: the words produced by browser speech recognition.

Your job is ONLY to compare the recognised words with the target phrase.

Do not judge accent, pronunciation quality, fluency, identity, ability, or level.
Do not give a score, percentage, grade, points, stars, marks, badges, or CEFR level.
Do not mention speech-recognition technology.

Use warm, encouraging, simple British English suitable for A1-A2 learners.
The learner-facing message must sound supportive and positive, never cold, abrupt, blaming, or discouraging.

Return ONLY valid JSON with exactly these keys:

{
  "status": "match" | "try_again" | "unclear",
  "message": "short learner-facing sentence, maximum 160 characters",
  "focus": "a short exact contiguous part of the TARGET PHRASE, or empty string"
}

Rules:

- status "match":
  recognised words clearly match the target phrase.
  focus must be "".
  Use an encouraging message such as:
  "✨ Great job! Your words matched the model phrase."

- status "try_again":
  there is a clear word or short phrase difference.
  Encourage the learner warmly to listen and try again.

- If the recognised text is a completely different word or phrase from the target:
  DO NOT say "Say [target] once more".
  DO NOT pretend the learner was close.
  Use a warm message such as:
  "🎉 Nice try! That was a different word. Listen to the model and have another go."
  focus must be "".

- If the recognised text is close to the target but one short part differs:
  you may use focus.
  Use a warm message such as:
  "💫 Good effort! You're close. Listen once more and try that part again."

- status "unclear":
  the recognised text is too incomplete or unclear to compare reliably.
  focus must be "".
  Use a reassuring message such as:
  "✅ No worries! I couldn't compare the words clearly this time. Listen once more and try again when you're ready."

- Ignore harmless punctuation, capitalisation, and contractions/apostrophe style.
- Never invent lesson content.
- Never output HTML, Markdown, explanations, or extra keys.

TARGET PHRASE:
${JSON.stringify(targetPhrase)}

RECOGNISED TEXT:
${JSON.stringify(recognisedText)}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 220,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Anthropic error:", response.status, data);
      return json(502, { error: "AI service unavailable." });
    }

    const raw = data?.content?.[0]?.text || "";
    let parsed;

    try {
      parsed = JSON.parse(stripCodeFences(raw));
    } catch {
      console.error("Invalid AI JSON:", raw);
      return json(502, { error: "Invalid AI response." });
    }

    const safe = validateFeedback(parsed, targetPhrase);

    if (!safe) {
      console.error("Rejected AI response:", parsed);
      return json(502, { error: "Unsafe or invalid AI response." });
    }

    return json(200, safe);

  } catch (error) {
    console.error("Server error:", error);
    return json(500, { error: "Server error." });
  }
};
