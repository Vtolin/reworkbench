// Supabase Edge Function: server-side embedding (cloud mode).
// Alternative to local Ollama embeddings. Called by the Vercel API route
// /api/rag/embed with the member's own context; never uses a shared key.
// Deploy: supabase functions deploy embed
// Env: EMBEDDING_API_URL, EMBEDDING_API_KEY (per-deployment, operator-owned;
// the per-member BYOK key is forwarded in the request body, never logged).

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  let body: { text?: string; apiKey?: string; model?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!body.text || !body.apiKey) {
    return new Response(
      JSON.stringify({ error: "text and apiKey are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const apiUrl =
    Deno.env.get("EMBEDDING_API_URL") ?? "https://api.openai.com/v1/embeddings";
  const model = body.model ?? "text-embedding-3-small";
  const upstream = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${body.apiKey}`,
    },
    body: JSON.stringify({ model, input: body.text }),
  });
  if (!upstream.ok) {
    return new Response(
      JSON.stringify({ error: `Upstream embedding failed: ${upstream.status}` }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
  const data = await upstream.json();
  const embedding: number[] | undefined = data?.data?.[0]?.embedding;
  if (!embedding) {
    return new Response(JSON.stringify({ error: "No embedding returned" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ embedding, model }), {
    headers: { "Content-Type": "application/json" },
  });
});
