const ALLOWED_STATUSES = new Set([
  "match",
  "try_again",
  "unclear"
]);

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

  return value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
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

  if (!f || !t) return false;

  return (` ${t} `).includes(` ${f} `);
}

function buildSafeFeedback(data, targetPhrase) {

  if (!data || typeof data !== "object") {
    return null;
  }

  const status = cleanText(
    data.status,
    20
  );

  if (!ALLOWED_STATUSES.has(status)) {
    return null;
  }

  let focus = cleanText(
    data.focus,
    60
  );

  /*
    focus may only contain an exact contiguous
    part of the target phrase.
  */
  if (!focusIsFromTarget(
    focus,
    targetPhrase
  )) {
    focus = "";
  }

  /*
    match and unclear never need a focus.
  */
  if (
    status === "match" ||
    status === "unclear"
  ) {
    focus = "";
  }

  /*
    IMPORTANT:
    The learner-facing message is generated
    here by the server.

    We do not display arbitrary AI wording.
  */

  let message = "";

  if (status === "match") {

    message =
      "Your words matched the model phrase.";

  } else if (status === "try_again") {

    if (focus) {
      message =
        `Good try. Say "${focus}" once more.`;
    } else {
      message =
        "Good try. Try the phrase once more.";
    }

  } else {

    message =
      "The words were not clear enough to compare. Listen and try again, or carry on.";
  }

  return {
    status,
    message,
    focus
  };
}

exports.handler = async function (event) {

  /*
    CORS preflight
  */
  if (event.httpMethod === "OPTIONS") {

    return {
      statusCode: 204,
      headers: corsHeaders(),
      body: ""
    };

  }

  /*
    POST only
  */
  if (event.httpMethod !== "POST") {

    return json(405, {
      error: "Method Not Allowed"
    });

  }

  /*
    API key must stay on Netlify only.
  */
  const apiKey =
    process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {

    console.error(
      "ANTHROPIC_API_KEY is not configured."
    );

    return json(500, {
      error: "AI service is not configured."
    });

  }

  try {

    let body;

    try {

      body = JSON.parse(
        event.body || "{}"
      );

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

    if (
      !targetPhrase ||
      !recognisedText
    ) {

      return json(400, {
        error:
          "Missing targetPhrase or recognisedText."
      });

    }

    const prompt = `
You are a careful British-English speaking-practice assistant for adult A1-A2 learners.

You are NOT listening to audio.

You receive:

TARGET PHRASE:
${JSON.stringify(targetPhrase)}

RECOGNISED TEXT:
${JSON.stringify(recognisedText)}

Your only task is to compare the recognised words with the target phrase.

Do not judge:
- accent
- pronunciation quality
- fluency
- identity
- ability
- learner level

Do not give:
- scores
- percentages
- grades
- points
- stars
- marks
- badges
- CEFR levels

Ignore harmless differences in:
- punctuation
- capitalisation
- apostrophe style
- ordinary contraction style

Return ONLY valid JSON.

Use exactly these keys:

{
  "status": "match",
  "focus": ""
}

Allowed status values:

"match"
Use when the recognised words clearly correspond to the target phrase.

"try_again"
Use when there is a clear word or short phrase difference.
focus may contain ONLY an exact contiguous sequence of words copied from TARGET PHRASE.

"unclear"
Use when the recognised text is too incomplete or unreliable to compare.
focus must be "".

Examples:

{
  "status": "match",
  "focus": ""
}

{
  "status": "try_again",
  "focus": "at seven"
}

{
  "status": "unclear",
  "focus": ""
}

Never output:
- a message field
- HTML
- Markdown
- explanations
- comments
- extra keys

Return JSON only.
`;

    const response = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "x-api-key":
            apiKey,

          "anthropic-version":
            "2023-06-01"
        },

        body: JSON.stringify({
          model:
            "claude-haiku-4-5-20251001",

          max_tokens: 120,

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

    let data;

    try {

      data =
        await response.json();

    } catch {

      console.error(
        "Anthropic returned invalid JSON."
      );

      return json(502, {
        error:
          "AI service unavailable."
      });

    }

    if (!response.ok) {

      console.error(
        "Anthropic error:",
        response.status,
        data
      );

      return json(502, {
        error:
          "AI service unavailable."
      });

    }

    const raw =
      data &&
      data.content &&
      data.content[0] &&
      typeof data.content[0].text === "string"
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
        error:
          "Invalid AI response."
      });

    }

    const safe =
      buildSafeFeedback(
        parsed,
        targetPhrase
      );

    if (!safe) {

      console.error(
        "Rejected AI response:",
        parsed
      );

      return json(502, {
        error:
          "Unsafe or invalid AI response."
      });

    }

    return json(
      200,
      safe
    );

  } catch (error) {

    console.error(
      "pronunciation-feedback error:",
      error
    );

    return json(500, {
      error: "Server error."
    });

  }

};
