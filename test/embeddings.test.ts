import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { handleEmbeddings } from "../embeddings";
import { db } from "../db";
import { generateKey, hashKey } from "../auth";
import { cacheKey, putCached } from "../cache";
import { resetDb } from "./setup";

// ── Helpers ───────────────────────────────────────────────────────────────────

function embReq(key: string, body: object) {
  return new Request("http://localhost/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function insertKey(name: string, budgetUsd: number | null = null): { id: number; raw: string } {
  const raw = generateKey();
  const hash = hashKey(raw);
  const r = db.run(
    "INSERT INTO api_keys (key_hash, key_prefix, name, budget_usd) VALUES (?, ?, ?, ?)",
    [hash, raw.slice(0, 12) + "...", name, budgetUsd],
  );
  return { id: Number(r.lastInsertRowid), raw };
}

function mockUpstream(embedding: number[], costUsd = 0.0001, tokens = 4) {
  globalThis.fetch = async () =>
    Response.json({
      data: [{ embedding, index: 0 }],
      usage: { total_tokens: tokens, cost: costUsd },
    });
}

function mockUpstreamBatch(embeddings: number[][]) {
  globalThis.fetch = async () =>
    Response.json({
      data: embeddings.map((embedding, index) => ({ embedding, index })),
      usage: { total_tokens: embeddings.length * 4, cost: 0.001 },
    });
}

let savedFetch: typeof fetch;
beforeEach(() => {
  savedFetch = globalThis.fetch;
  resetDb();
});
afterEach(() => {
  globalThis.fetch = savedFetch;
});

// ── Authentication ─────────────────────────────────────────────────────────────

describe("authentication", () => {
  test("rejects request with no Authorization header", async () => {
    const req = new Request("http://localhost/v1/embeddings", { method: "POST" });
    expect((await handleEmbeddings(req)).status).toBe(401);
  });

  test("rejects request with a non-Bearer scheme", async () => {
    const req = new Request("http://localhost/v1/embeddings", {
      method: "POST",
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect((await handleEmbeddings(req)).status).toBe(401);
  });

  test("rejects an unknown API key", async () => {
    const res = await handleEmbeddings(embReq("emb_notakey", { model: "m", input: "hi" }));
    expect(res.status).toBe(401);
  });

  test("rejects a disabled API key", async () => {
    const raw = generateKey();
    db.run(
      "INSERT INTO api_keys (key_hash, key_prefix, name, enabled) VALUES (?, ?, ?, 0)",
      [hashKey(raw), raw.slice(0, 12) + "...", "disabled"],
    );
    const res = await handleEmbeddings(embReq(raw, { model: "m", input: "hi" }));
    expect(res.status).toBe(401);
  });
});

// ── Input Validation ──────────────────────────────────────────────────────────

describe("input validation", () => {
  test("rejects invalid JSON body", async () => {
    const { raw } = insertKey("t");
    const req = new Request("http://localhost/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${raw}`, "Content-Type": "application/json" },
      body: "not json",
    });
    expect((await handleEmbeddings(req)).status).toBe(400);
  });

  test("rejects missing model field", async () => {
    const { raw } = insertKey("t");
    const res = await handleEmbeddings(embReq(raw, { input: "hello" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/model/i);
  });

  test("rejects missing input field", async () => {
    const { raw } = insertKey("t");
    const res = await handleEmbeddings(embReq(raw, { model: "m" }));
    expect(res.status).toBe(400);
  });

  test("rejects empty input array", async () => {
    const { raw } = insertKey("t");
    const res = await handleEmbeddings(embReq(raw, { model: "m", input: [] }));
    expect(res.status).toBe(400);
  });

  test("accepts a string input", async () => {
    const { raw } = insertKey("t");
    mockUpstream([0.1, 0.2]);
    const res = await handleEmbeddings(embReq(raw, { model: "m", input: "hello" }));
    expect(res.status).toBe(200);
  });

  test("accepts an array of strings", async () => {
    const { raw } = insertKey("t");
    mockUpstreamBatch([[0.1], [0.2]]);
    const res = await handleEmbeddings(embReq(raw, { model: "m", input: ["a", "b"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
  });
});

// ── Cache Hits ────────────────────────────────────────────────────────────────

describe("cache hit path", () => {
  test("returns cached embedding without calling upstream", async () => {
    const { raw } = insertKey("t");
    const model = "openai/text-embedding-3-small";
    const key = cacheKey(model, "cached input");
    putCached(key, model, [0.1, 0.2, 0.3], 4);

    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return Response.json({}); };

    const res = await handleEmbeddings(embReq(raw, { model, input: "cached input" }));
    expect(res.status).toBe(200);
    expect(fetchCalled).toBe(false);

    const body = await res.json();
    expect(body.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
  });

  test("partial batch: cache hit + upstream miss are merged correctly", async () => {
    const { raw } = insertKey("t");
    const model = "openai/text-embedding-3-small";

    // Pre-cache the first input only
    const key0 = cacheKey(model, "cached");
    putCached(key0, model, [1, 1, 1], 3);

    // Upstream will serve the second input
    globalThis.fetch = async () =>
      Response.json({
        data: [{ embedding: [2, 2, 2], index: 0 }],
        usage: { total_tokens: 4, cost: 0.0001 },
      });

    const res = await handleEmbeddings(embReq(raw, { model, input: ["cached", "uncached"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    // Index ordering must be preserved
    expect(body.data[0].embedding).toEqual([1, 1, 1]);
    expect(body.data[1].embedding).toEqual([2, 2, 2]);
  });

  test("fully cached batch does not call upstream at all", async () => {
    const { raw } = insertKey("t");
    const model = "openai/text-embedding-3-small";
    putCached(cacheKey(model, "a"), model, [0.1], 2);
    putCached(cacheKey(model, "b"), model, [0.2], 2);

    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return Response.json({}); };

    const res = await handleEmbeddings(embReq(raw, { model, input: ["a", "b"] }));
    expect(res.status).toBe(200);
    expect(fetchCalled).toBe(false);
  });
});

// ── Upstream Fetch ────────────────────────────────────────────────────────────

describe("upstream fetch path", () => {
  test("returns embedding from upstream and stores it in cache", async () => {
    const { raw } = insertKey("t");
    const model = "openai/text-embedding-3-small";
    mockUpstream([0.5, 0.6, 0.7]);

    const res = await handleEmbeddings(embReq(raw, { model, input: "fresh input" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].embedding).toEqual([0.5, 0.6, 0.7]);

    // Verify stored in cache
    const cached = (await import("../cache")).getCached(cacheKey(model, "fresh input"));
    expect(cached).not.toBeNull();
    expect(cached!.embedding).toEqual([0.5, 0.6, 0.7]);
  });

  test("returns 502 when upstream call fails", async () => {
    const { raw } = insertKey("t");
    globalThis.fetch = async () => new Response("Internal Server Error", { status: 500 });

    const res = await handleEmbeddings(embReq(raw, { model: "m", input: "test" }));
    expect(res.status).toBe(502);
  });

  test("returns 502 when upstream throws a network error", async () => {
    const { raw } = insertKey("t");
    globalThis.fetch = async () => { throw new Error("Network failure"); };

    const res = await handleEmbeddings(embReq(raw, { model: "m", input: "test" }));
    expect(res.status).toBe(502);
  });

  test("response includes correct usage token count", async () => {
    const { raw } = insertKey("t");
    mockUpstream([0.1], 0.0001, 7);

    const body = await (await handleEmbeddings(embReq(raw, { model: "m", input: "tok" }))).json();
    expect(body.usage.total_tokens).toBe(7);
    expect(body.usage.prompt_tokens).toBe(7);
  });
});

// ── Budget Enforcement ────────────────────────────────────────────────────────

describe("budget enforcement", () => {
  test("returns 429 when key's budget is exhausted", async () => {
    const { id, raw } = insertKey("limited", 0.001);
    db.run(
      "INSERT INTO requests (key_id, model, input_count, cache_hits, upstream_count, upstream_tokens, cost_usd) VALUES (?, ?, 1, 0, 1, 100, 0.002)",
      [id, "m"],
    );

    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return Response.json({}); };

    const res = await handleEmbeddings(embReq(raw, { model: "m", input: "uncached" }));
    expect(res.status).toBe(429);
    expect(fetchCalled).toBe(false);
  });

  test("still serves cached content when budget is exhausted", async () => {
    const { id, raw } = insertKey("limited", 0.001);
    db.run(
      "INSERT INTO requests (key_id, model, input_count, cache_hits, upstream_count, upstream_tokens, cost_usd) VALUES (?, ?, 1, 0, 1, 100, 0.002)",
      [id, "m"],
    );

    const model = "openai/text-embedding-3-small";
    putCached(cacheKey(model, "pre-cached"), model, [9, 8, 7], 3);

    const res = await handleEmbeddings(embReq(raw, { model, input: "pre-cached" }));
    expect(res.status).toBe(200);
    expect((await res.json()).data[0].embedding).toEqual([9, 8, 7]);
  });

  test("unlimited budget (null) always allows upstream calls", async () => {
    const { raw } = insertKey("unlimited", null);
    mockUpstream([0.1]);

    // Run many requests
    for (let i = 0; i < 3; i++) {
      const res = await handleEmbeddings(embReq(raw, { model: "m", input: `input-${i}` }));
      expect(res.status).toBe(200);
    }
  });
});

// ── Request Logging ───────────────────────────────────────────────────────────

describe("request logging", () => {
  test("logs a fully-cached request", async () => {
    const { id, raw } = insertKey("t");
    const model = "openai/text-embedding-3-small";
    putCached(cacheKey(model, "hi"), model, [0.1], 2);

    await handleEmbeddings(embReq(raw, { model, input: "hi" }));

    const row = db.query<any, [number]>("SELECT * FROM requests WHERE key_id = ?").get(id);
    expect(row).not.toBeNull();
    expect(row.input_count).toBe(1);
    expect(row.cache_hits).toBe(1);
    expect(row.upstream_count).toBe(0);
    expect(row.cost_usd).toBe(0);
  });

  test("logs an upstream request with correct cost", async () => {
    const { id, raw } = insertKey("t");
    mockUpstream([0.1], 0.0025, 10);

    await handleEmbeddings(embReq(raw, { model: "m", input: "new text" }));

    const row = db.query<any, [number]>("SELECT * FROM requests WHERE key_id = ?").get(id);
    expect(row.input_count).toBe(1);
    expect(row.cache_hits).toBe(0);
    expect(row.upstream_count).toBe(1);
    expect(row.cost_usd).toBeCloseTo(0.0025);
    expect(row.upstream_tokens).toBe(10);
  });

  test("logs a mixed batch correctly", async () => {
    const { id, raw } = insertKey("t");
    const model = "m";
    putCached(cacheKey(model, "cached"), model, [1], 2);

    globalThis.fetch = async () =>
      Response.json({
        data: [{ embedding: [2], index: 0 }],
        usage: { total_tokens: 5, cost: 0.001 },
      });

    await handleEmbeddings(embReq(raw, { model, input: ["cached", "miss"] }));

    const row = db.query<any, [number]>("SELECT * FROM requests WHERE key_id = ?").get(id);
    expect(row.input_count).toBe(2);
    expect(row.cache_hits).toBe(1);
    expect(row.upstream_count).toBe(1);
  });

  test("response object matches OpenAI embedding format", async () => {
    const { raw } = insertKey("t");
    mockUpstream([0.1, 0.2]);

    const body = await (await handleEmbeddings(embReq(raw, { model: "m", input: "test" }))).json();
    expect(body.object).toBe("list");
    expect(body.data[0].object).toBe("embedding");
    expect(body.data[0].index).toBe(0);
    expect(body.data[0].embedding).toEqual([0.1, 0.2]);
    expect(body.model).toBe("m");
    expect(body.usage).toMatchObject({ prompt_tokens: expect.any(Number), total_tokens: expect.any(Number) });
  });
});
