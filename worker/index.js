/**
 * Cloudflare Worker — Gemini API proxy
 *
 * Accepts POST { prompt: string } and forwards it to the Gemini API,
 * returning { text: string }.  The Gemini API key is stored as a
 * Worker secret (GEMINI_API_KEY) and is never exposed to the browser.
 *
 * Deploy:
 *   cd worker
 *   npx wrangler secret put GEMINI_API_KEY   # paste your key when prompted
 *   npx wrangler deploy
 */

const GEMINI_MODEL = "gemini-1.5-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: corsHeaders(),
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    if (!body.prompt || typeof body.prompt !== "string") {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid "prompt" field' }),
        {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        }
      );
    }

    if (!env.GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "GEMINI_API_KEY secret is not configured" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        }
      );
    }

    const geminiRes = await fetch(
      `${GEMINI_ENDPOINT}?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: body.prompt }] }],
          generationConfig: { temperature: 0.2 },
        }),
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      return new Response(
        JSON.stringify({
          error: `Gemini API error (${geminiRes.status})`,
          details: data,
        }),
        {
          status: geminiRes.status,
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        }
      );
    }

    // Gemini response shape: candidates[0].content.parts[0].text
    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    return new Response(JSON.stringify({ text }), {
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  },
};
