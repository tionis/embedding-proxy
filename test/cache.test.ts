import { describe, test, expect, beforeEach } from "bun:test";
import { cacheKey, getCached, putCached } from "../cache";
import { db } from "../db";
import { resetDb } from "./setup";

// ── cacheKey ──────────────────────────────────────────────────────────────────

describe("cacheKey", () => {
  test("produces a 64-char hex string", () => {
    const k = cacheKey("model", "input");
    expect(k).toHaveLength(64);
    expect(k).toMatch(/^[0-9a-f]+$/);
  });

  test("is deterministic", () => {
    expect(cacheKey("model", "hello")).toBe(cacheKey("model", "hello"));
  });

  test("differs when model changes", () => {
    expect(cacheKey("model-a", "hello")).not.toBe(cacheKey("model-b", "hello"));
  });

  test("differs when input changes", () => {
    expect(cacheKey("model", "hello")).not.toBe(cacheKey("model", "world"));
  });
});

// ── getCached / putCached ─────────────────────────────────────────────────────

describe("getCached / putCached", () => {
  beforeEach(resetDb);

  test("returns null for a key that has not been cached", () => {
    expect(getCached("nonexistent-key")).toBeNull();
  });

  test("stores and retrieves an embedding", () => {
    const key = cacheKey("openai/text-embedding-3-small", "hello world");
    putCached(key, "openai/text-embedding-3-small", [0.1, 0.2, 0.3], 4);
    const result = getCached(key);
    expect(result).not.toBeNull();
    expect(result!.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(result!.tokens).toBe(4);
  });

  test("preserves high-precision float values", () => {
    const embedding = [0.0023642, -0.00912345, 1.23456789];
    const key = cacheKey("model", "precision-test");
    putCached(key, "model", embedding, 3);
    const result = getCached(key);
    expect(result!.embedding[0]).toBeCloseTo(0.0023642, 6);
    expect(result!.embedding[1]).toBeCloseTo(-0.00912345, 6);
  });

  test("increments hit_count on each getCached call", () => {
    const key = cacheKey("model", "hit-count-test");
    putCached(key, "model", [1], 1);

    getCached(key);
    getCached(key);
    getCached(key);

    const row = db.query<{ hit_count: number }, [string]>(
      "SELECT hit_count FROM embeddings_cache WHERE cache_key = ?",
    ).get(key);
    expect(row!.hit_count).toBe(3);
  });

  test("putCached is idempotent — duplicate insert does not overwrite", () => {
    const key = cacheKey("model", "idempotent-test");
    putCached(key, "model", [1, 2, 3], 5);
    putCached(key, "model", [9, 9, 9], 99); // should be silently ignored

    const result = getCached(key);
    expect(result!.embedding).toEqual([1, 2, 3]);
    expect(result!.tokens).toBe(5);
  });

  test("stores the correct model on the cache entry", () => {
    const model = "openai/text-embedding-3-large";
    const key = cacheKey(model, "model-check");
    putCached(key, model, [0.5], 2);

    const row = db.query<{ model: string }, [string]>(
      "SELECT model FROM embeddings_cache WHERE cache_key = ?",
    ).get(key);
    expect(row!.model).toBe(model);
  });

  test("can store and retrieve large embeddings (1536 dims)", () => {
    const embedding = Array.from({ length: 1536 }, (_, i) => i * 0.001);
    const key = cacheKey("openai/text-embedding-3-small", "large-embedding");
    putCached(key, "openai/text-embedding-3-small", embedding, 10);
    const result = getCached(key);
    expect(result!.embedding).toHaveLength(1536);
    expect(result!.embedding[100]).toBeCloseTo(0.1, 4);
  });
});
