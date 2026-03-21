import { describe, test, expect, beforeEach } from "bun:test";
import { hashKey, generateKey, extractBearer, lookupApiKey, checkBudget } from "../auth";
import { db } from "../db";
import { resetDb } from "./setup";

// ── hashKey ──────────────────────────────────────────────────────────────────

describe("hashKey", () => {
  test("produces a 64-char hex string", () => {
    const h = hashKey("some-key");
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  test("is deterministic", () => {
    expect(hashKey("abc")).toBe(hashKey("abc"));
  });

  test("differs for different inputs", () => {
    expect(hashKey("key1")).not.toBe(hashKey("key2"));
  });
});

// ── generateKey ──────────────────────────────────────────────────────────────

describe("generateKey", () => {
  test("starts with emb_ prefix", () => {
    expect(generateKey()).toMatch(/^emb_/);
  });

  test("produces unique keys each call", () => {
    expect(generateKey()).not.toBe(generateKey());
  });

  test("has sufficient length (>= 40 chars)", () => {
    expect(generateKey().length).toBeGreaterThanOrEqual(40);
  });
});

// ── extractBearer ─────────────────────────────────────────────────────────────

describe("extractBearer", () => {
  test("extracts token from valid Authorization header", () => {
    const req = new Request("http://x", {
      headers: { Authorization: "Bearer abc123" },
    });
    expect(extractBearer(req)).toBe("abc123");
  });

  test("returns null when header is absent", () => {
    expect(extractBearer(new Request("http://x"))).toBeNull();
  });

  test("returns null for non-Bearer schemes", () => {
    const req = new Request("http://x", { headers: { Authorization: "Basic dXNlcjpwYXNz" } });
    expect(extractBearer(req)).toBeNull();
  });

  test("returns null for empty Authorization header", () => {
    const req = new Request("http://x", { headers: { Authorization: "" } });
    expect(extractBearer(req)).toBeNull();
  });
});

// ── lookupApiKey ──────────────────────────────────────────────────────────────

describe("lookupApiKey", () => {
  beforeEach(resetDb);

  test("returns null for an unknown key", () => {
    expect(lookupApiKey("emb_unknown")).toBeNull();
  });

  test("returns the key row for a known, enabled key", () => {
    const raw = generateKey();
    const hash = hashKey(raw);
    db.run(
      "INSERT INTO api_keys (key_hash, key_prefix, name) VALUES (?, ?, ?)",
      [hash, raw.slice(0, 12) + "...", "test-token"],
    );
    const result = lookupApiKey(raw);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("test-token");
    expect(result!.enabled).toBe(1);
  });

  test("returns null for a disabled key", () => {
    const raw = generateKey();
    const hash = hashKey(raw);
    db.run(
      "INSERT INTO api_keys (key_hash, key_prefix, name, enabled) VALUES (?, ?, ?, 0)",
      [hash, raw.slice(0, 12) + "...", "disabled-token"],
    );
    expect(lookupApiKey(raw)).toBeNull();
  });
});

// ── checkBudget ───────────────────────────────────────────────────────────────

describe("checkBudget", () => {
  beforeEach(resetDb);

  function insertKey(budgetUsd: number | null = null): number {
    const r = db.run(
      "INSERT INTO api_keys (key_hash, key_prefix, name, budget_usd) VALUES (?, ?, ?, ?)",
      [Math.random().toString(), "pfx...", "t", budgetUsd],
    );
    return Number(r.lastInsertRowid);
  }

  function insertRequest(keyId: number, costUsd: number) {
    db.run(
      `INSERT INTO requests
         (key_id, model, input_count, cache_hits, upstream_count, upstream_tokens, cost_usd)
       VALUES (?, ?, 1, 0, 1, 10, ?)`,
      [keyId, "m", costUsd],
    );
  }

  test("ok=true and spent=0 for a new key with no budget", () => {
    const id = insertKey(null);
    expect(checkBudget(id, null)).toEqual({ ok: true, spent: 0 });
  });

  test("ok=true and spent=0 for a new key with a budget", () => {
    const id = insertKey(5.0);
    expect(checkBudget(id, 5.0)).toEqual({ ok: true, spent: 0 });
  });

  test("ok=true when spend is below the budget", () => {
    const id = insertKey(1.0);
    insertRequest(id, 0.5);
    const result = checkBudget(id, 1.0);
    expect(result.ok).toBe(true);
    expect(result.spent).toBeCloseTo(0.5);
  });

  test("ok=false when spend equals or exceeds budget", () => {
    const id = insertKey(0.5);
    insertRequest(id, 0.6);
    const result = checkBudget(id, 0.5);
    expect(result.ok).toBe(false);
    expect(result.spent).toBeCloseTo(0.6);
  });

  test("aggregates spend across multiple requests", () => {
    const id = insertKey(0.8);
    insertRequest(id, 0.3);
    insertRequest(id, 0.3);
    insertRequest(id, 0.3); // total 0.9 > 0.8 budget
    const result = checkBudget(id, 0.8);
    expect(result.ok).toBe(false);
    expect(result.spent).toBeCloseTo(0.9);
  });
});
