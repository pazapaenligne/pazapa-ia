// netlify/functions/transcribe.js
// Receives a short browser recording as Base64 JSON and returns transcription text.
// Required Netlify environment variable: OPENAI_API_KEY

const ALLOWED_MIME = new Set([
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/ogg;codecs=opus",
  "audio/m4a",
  "audio/x-m4a"
]);

const MAX_BASE64_CHARS = 5_000_000;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };
}

function extensionForMime(mime) {
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

exports.handler = async function(event) {
  const headers = corsHeaders();

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers,
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({
        error: "Method not allowed"
      })
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Transcription service is not configured"
      })
    };
  }

  let payload;

  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: "Invalid JSON"
      })
    };
  }

  const audioBase64 = String(payload.audioBase64 || "");
  const mimeType = String(
    payload.mimeType || "audio/webm"
  ).toLowerCase();

  if (
    !audioBase64 ||
    audioBase64.length > MAX_BASE64_CHARS
  ) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: "Audio is missing or too large"
      })
    };
  }

  if (!ALLOWED_MIME.has(mimeType)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: "Unsupported audio type"
      })
    };
  }

  let audioBuffer;

  try {
    audioBuffer = Buffer.from(
      audioBase64,
      "base64"
    );
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: "Invalid audio data"
      })
    };
  }

  if (!audioBuffer.length) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: "Empty audio"
      })
    };
  }

  try {
    const form = new FormData();

    const ext = extensionForMime(
      mimeType
    );

    const blob = new Blob(
      [audioBuffer],
      {
        type: mimeType
      }
    );

    form.append(
      "file",
      blob,
      `speech.${ext}`
    );

    form.append(
      "model",
      "gpt-4o-mini-transcribe"
    );

    form.append(
      "language",
      "en"
    );

    const response = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          "Authorization":
            `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: form
      }
    );

    const raw =
      await response.text();

    if (!response.ok) {
      console.error(
        "OpenAI transcription error:",
        response.status,
        raw.slice(0, 500)
      );

      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: "Transcription failed"
        })
      };
    }

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: "Invalid transcription response"
        })
      };
    }

    const text = String(
      data.text || ""
    ).trim();

    if (!text) {
      return {
        statusCode: 422,
        headers,
        body: JSON.stringify({
          error: "No speech recognised"
        })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        text
      })
    };
  } catch (error) {
    console.error(
      "transcribe function error:",
      error
    );

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Transcription service error"
      })
    };
  }
};
