import { db } from "./db";
import { createHash } from "crypto";

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
