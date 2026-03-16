import { db } from "./db";
import { extractBearer, lookupApiKey, checkBudget } from "./auth";
import { cacheKey, getCached, putCached } from "./cache";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/embeddings";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";

function normalizeInput(input: unknown): string[] {
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) return input.map(String);
  throw new Error("input must be a string or array of strings");
}

type UpstreamResult = {
  embeddings: number[][];
  tokens: number;
  cost_usd: number;
};

async function fetchFromUpstream(model: string, inputs: string[]): Promise<UpstreamResult> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENROUTER_KEY}`,
      "HTTP-Referer": "https://embeddings-nuj.sprites.app",
    },
    body: JSON.stringify({ model, input: inputs }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text}`);
  }

  // OpenRouter reports cost in the response body under usage.cost (in USD)
  // and also as the x-openrouter-cost header.
  const headerCost = parseFloat(res.headers.get("x-openrouter-cost") ?? "0") || 0;

  const body = await res.json() as {
    data: { embedding: number[]; index: number }[];
    usage: { prompt_tokens: number; total_tokens: number; cost?: number };
  };

  const cost_usd = body.usage?.cost ?? headerCost;
  const tokens = body.usage?.total_tokens ?? 0;
  const sorted = [...body.data].sort((a, b) => a.index - b.index);

  return { embeddings: sorted.map(d => d.embedding), tokens, cost_usd };
}

export async function handleEmbeddings(req: Request): Promise<Response> {
  // Auth
  const rawKey = extractBearer(req);
  if (!rawKey) return jsonErr("Missing Authorization header", 401);
  const apiKey = lookupApiKey(rawKey);
  if (!apiKey) return jsonErr("Invalid or disabled API key", 401);

  let body: { model?: string; input?: unknown; encoding_format?: string };
  try {
    body = await req.json();
  } catch {
    return jsonErr("Invalid JSON body", 400);
  }

  const model = body.model;
  if (!model) return jsonErr("model is required", 400);

  let inputs: string[];
  try {
    inputs = normalizeInput(body.input);
  } catch (e: any) {
    return jsonErr(e.message, 400);
  }
  if (inputs.length === 0) return jsonErr("input must not be empty", 400);

  // Per-input cache lookup
  const results: { index: number; embedding: number[]; tokens: number; hit: boolean }[] = [];
  const missIndices: number[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const key = cacheKey(model, inputs[i]);
    const cached = getCached(key);
    if (cached) {
      results.push({ index: i, embedding: cached.embedding, tokens: cached.tokens, hit: true });
    } else {
      missIndices.push(i);
    }
  }

  // Budget check — only matters if there are cache misses that need upstream
  if (missIndices.length > 0) {
    const budget = checkBudget(apiKey.id, apiKey.budget_usd);
    if (!budget.ok) {
      return jsonErr(
        `Upstream budget exceeded ($${budget.spent.toFixed(6)} spent / $${apiKey.budget_usd!.toFixed(2)} limit). ` +
        `Cached inputs are still served — retry with already-cached content.`,
        429
      );
    }
  }

  // Fetch misses from upstream
  let upstream_tokens = 0;
  let cost_usd = 0;

  if (missIndices.length > 0) {
    if (!OPENROUTER_KEY) return jsonErr("No OPENROUTER_API_KEY configured", 503);

    const missInputs = missIndices.map(i => inputs[i]);
    let upstream: UpstreamResult;
    try {
      upstream = await fetchFromUpstream(model, missInputs);
    } catch (e: any) {
      return jsonErr(`Upstream error: ${e.message}`, 502);
    }

    upstream_tokens = upstream.tokens;
    cost_usd = upstream.cost_usd;

    // Distribute tokens evenly per cached entry (OpenRouter gives aggregate total)
    const tokensEach = missInputs.length > 0 ? Math.ceil(upstream_tokens / missInputs.length) : 0;

    for (let j = 0; j < missIndices.length; j++) {
      const origIdx = missIndices[j];
      putCached(cacheKey(model, inputs[origIdx]), model, upstream.embeddings[j], tokensEach);
      results.push({ index: origIdx, embedding: upstream.embeddings[j], tokens: tokensEach, hit: false });
    }
  }

  results.sort((a, b) => a.index - b.index);

  // Always log — cache hits included so we can track ratios over time
  db.run(
    `INSERT INTO requests (key_id, model, input_count, cache_hits, upstream_count, upstream_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      apiKey.id, model,
      inputs.length,
      results.filter(r => r.hit).length,
      missIndices.length,
      upstream_tokens,
      cost_usd,
    ]
  );

  const totalTokens = results.reduce((s, r) => s + r.tokens, 0);

  return Response.json({
    object: "list",
    data: results.map(r => ({
      object: "embedding",
      index: r.index,
      embedding: r.embedding,
    })),
    model,
    usage: {
      prompt_tokens: totalTokens,
      total_tokens: totalTokens,
    },
  });
}

function jsonErr(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
