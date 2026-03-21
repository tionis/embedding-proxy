import { db } from "./db";
import { createHash } from "crypto";
import { extractBearer, lookupApiKey } from "./auth";

export function cacheKey(model: string, input: string): string {
  return createHash("sha256").update(model + "\x00" + input).digest("hex");
}

export function getCached(key: string): { embedding: number[]; tokens: number } | null {
  const row = db.query<{ embedding: string; tokens: number }, [string]>(
    "SELECT embedding, tokens FROM embeddings_cache WHERE cache_key = ?"
  ).get(key);
  if (!row) return null;

  // Bump hit stats async (fire-and-forget)
  db.run(
    "UPDATE embeddings_cache SET hit_count = hit_count + 1, last_hit = datetime('now') WHERE cache_key = ?",
    [key]
  );
  return { embedding: JSON.parse(row.embedding), tokens: row.tokens };
}

export function putCached(key: string, model: string, embedding: number[], tokens: number): void {
  db.run(
    `INSERT INTO embeddings_cache (cache_key, model, embedding, tokens)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(cache_key) DO NOTHING`,
    [key, model, JSON.stringify(embedding), tokens]
  );
}

export async function handleCacheLookup(req: Request): Promise<Response> {
  const rawKey = extractBearer(req);
  if (!rawKey) return jsonErr("Missing Authorization header", 401);
  const apiKey = lookupApiKey(rawKey);
  if (!apiKey) return jsonErr("Invalid or disabled API key", 401);

  let body: { keys?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonErr("Invalid JSON body", 400);
  }

  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    return jsonErr("keys must be a non-empty array of cache key strings", 400);
  }
  if (body.keys.length > 999) {
    return jsonErr("keys must contain at most 999 entries — split into smaller batches", 400);
  }
  const keys: string[] = body.keys.map(String);

  const placeholders = keys.map(() => "?").join(", ");
  const rows = db.query<{ cache_key: string; embedding: string }, string[]>(
    `SELECT cache_key, embedding FROM embeddings_cache WHERE cache_key IN (${placeholders})`
  ).all(...keys);

  // Bump hit counts for matched keys
  if (rows.length > 0) {
    const hitPlaceholders = rows.map(() => "?").join(", ");
    db.run(
      `UPDATE embeddings_cache SET hit_count = hit_count + 1, last_hit = datetime('now') WHERE cache_key IN (${hitPlaceholders})`,
      rows.map(r => r.cache_key)
    );
  }

  const hitMap = new Map(rows.map(r => [r.cache_key, JSON.parse(r.embedding) as number[]]));
  const hits: Record<string, { object: string; embedding: number[] }> = {};
  const misses: string[] = [];

  for (const key of keys) {
    const embedding = hitMap.get(key);
    if (embedding) {
      hits[key] = { object: "embedding", embedding };
    } else {
      misses.push(key);
    }
  }

  return Response.json({ hits, misses });
}

function jsonErr(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
