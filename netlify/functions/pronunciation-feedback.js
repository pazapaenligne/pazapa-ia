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

  if (/[<>{}\[\]\\|`~^]|https?:|data:|javascript:/i.test(message)) {
    return null;
  }

  if (
    /\d|%|\bscores?\b|\bstars?\b|\bgrades?\b|\blevels?\b|\bpoints?\b|\bmarks?\b|\bbadges?\b/i.test(
      message
    )
  ) {
    return null;
  }

  if (!focusIsFromTarget(focus, targetPhrase)) {
    focus = "";
  }

  return {
    status,
    message,
    focus
  };
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
    return json(405, {
      error: "Method Not Allowed"
    });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return json(500, {
      error: "AI service is not configured."
    });
  }

  try {

    let body;

    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, {
        error: "Invalid JSON."
      });
    }

    const targetPhrase = cleanText(
      body.targetPhrase,
      180
    );

    const recognisedText = cleanText(
      body.recognisedText,
      300
    );

    if (!targetPhrase || !recognisedText) {
      return json(400, {
        error: "Missing targetPhrase or recognisedText."
      });
    }

    const prompt = `
You are a careful British-English pronunciation practice assistant
for adult A1-A2 learners.

You receive:

TARGET PHRASE:
the exact model sentence.

RECOGNISED TEXT:
the words produced by browser speech recognition.

Your job is ONLY to compare the recognised words
with the target phrase.

Do not judge:
- accent
- pronunciation quality
- fluency
- identity
- ability
- learner level

Do not give:
- a score
- a percentage
- a grade
- points
- stars
- marks
- badges
- CEFR levels

Do not mention speech-recognition technology.

Use calm, simple British English suitable
for A1-A2 learners.

Return ONLY valid JSON.

Use exactly these keys:

{
  "status": "match" | "try_again" | "unclear",
  "message": "short learner-facing sentence",
  "focus": "exact words from the target phrase or empty string"
}

RULES

status "match":
The recognised words clearly match the target phrase.
focus must be "".

status "try_again":
There is a clear word or short phrase difference.
Give a short encouraging message.
focus may contain ONLY an exact contiguous part
copied from TARGET PHRASE.

status "unclear":
The recognised text is too incomplete or unclear
to compare reliably.
focus must be "".

Ignore harmless:
- punctuation
- capitalisation
- apostrophe style
- contraction style

Never invent lesson content.

Never output:
- HTML
- Markdown
- explanations
- extra keys

The message must be no longer than 160 characters.

TARGET PHRASE:
${JSON.stringify(targetPhrase)}

RECOGNISED TEXT:
${JSON.stringify(recognisedText)}
`;

    const response = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
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
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(
        "Anthropic error:",
        response.status,
        data
      );

      return json(502, {
        error: "AI service unavailable."
      });
    }

    const raw =
      data &&
      data.content &&
      data.content[0] &&
      data.content[0].text
        ? data.content[0].text
        : "";

    let parsed;

    try {
      parsed = JSON.parse(
        stripCodeFences(raw)
      );
    } catch {
      console.error(
        "Invalid AI JSON:",
        raw
      );

      return json(502, {
        error: "Invalid AI response."
      });
    }

    const safe = validateFeedback(
      parsed,
      targetPhrase
    );

    if (!safe) {
      console.error(
        "Rejected AI response:",
        parsed
      );

      return json(502, {
        error: "Unsafe or invalid AI response."
      });
    }

    return json(
      200,
      safe
    );

  } catch (error) {

    console.error(
      "Server error:",
      error
    );

    return json(500, {
      error: "Server error."
    });

  }
};
