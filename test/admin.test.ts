import { describe, test, expect, beforeEach } from "bun:test";
import { handleAdmin } from "../admin";
import { db } from "../db";
import { resetDb } from "./setup";

const ADMIN = "test-admin-key";

function req(method: string, path: string, body?: object, key = ADMIN) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function json(res: Response) {
  return res.json();
}

// ── Auth ──────────────────────────────────────────────────────────────────────

describe("admin auth", () => {
  test("rejects request with no Authorization header", async () => {
    const res = await handleAdmin(new Request("http://localhost/admin/stats"), "/admin/stats");
    expect(res.status).toBe(401);
  });

  test("rejects request with wrong key", async () => {
    const res = await handleAdmin(req("GET", "/admin/stats", undefined, "wrong"), "/admin/stats");
    expect(res.status).toBe(401);
  });

  test("accepts request with correct key", async () => {
    const res = await handleAdmin(req("GET", "/admin/stats"), "/admin/stats");
    expect(res.status).toBe(200);
  });
});

// ── Token CRUD ────────────────────────────────────────────────────────────────

describe("POST /admin/tokens", () => {
  beforeEach(resetDb);

  test("creates a token and returns the plaintext key", async () => {
    const res = await handleAdmin(req("POST", "/admin/tokens", { name: "my-app" }), "/admin/tokens");
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.key).toMatch(/^emb_/);
    expect(body.name).toBe("my-app");
  });

  test("creates a token with a budget", async () => {
    const res = await handleAdmin(
      req("POST", "/admin/tokens", { name: "budgeted", budget_usd: 5.0 }),
      "/admin/tokens",
    );
    expect(res.status).toBe(201);
  });

  test("rejects creation without a name", async () => {
    const res = await handleAdmin(req("POST", "/admin/tokens", {}), "/admin/tokens");
    expect(res.status).toBe(400);
  });
});

describe("GET /admin/tokens", () => {
  beforeEach(resetDb);

  test("returns an empty array when no tokens exist", async () => {
    const res = await handleAdmin(req("GET", "/admin/tokens"), "/admin/tokens");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual([]);
  });

  test("returns all created tokens with aggregate stats", async () => {
    await handleAdmin(req("POST", "/admin/tokens", { name: "tok1" }), "/admin/tokens");
    await handleAdmin(req("POST", "/admin/tokens", { name: "tok2" }), "/admin/tokens");

    const res = await handleAdmin(req("GET", "/admin/tokens"), "/admin/tokens");
    const tokens = await json(res);
    expect(tokens).toHaveLength(2);
    expect(tokens.map((t: any) => t.name)).toContain("tok1");
    expect(tokens.map((t: any) => t.name)).toContain("tok2");
  });

  test("includes usage stats fields", async () => {
    await handleAdmin(req("POST", "/admin/tokens", { name: "stats-tok" }), "/admin/tokens");
    const [token] = await json(await handleAdmin(req("GET", "/admin/tokens"), "/admin/tokens"));
    expect(token).toMatchObject({
      total_requests: 0,
      total_inputs: 0,
      cache_hits: 0,
      upstream_count: 0,
      total_cost_usd: 0,
    });
  });
});

describe("GET /admin/tokens/:id", () => {
  beforeEach(resetDb);

  test("returns token detail with stats and by_model", async () => {
    await handleAdmin(req("POST", "/admin/tokens", { name: "detail" }), "/admin/tokens");
    const [{ id }] = await json(await handleAdmin(req("GET", "/admin/tokens"), "/admin/tokens"));

    const res = await handleAdmin(req("GET", `/admin/tokens/${id}`), `/admin/tokens/${id}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.name).toBe("detail");
    expect(body.stats).toBeDefined();
    expect(body.by_model).toBeInstanceOf(Array);
  });

  test("returns 404 for a non-existent id", async () => {
    const res = await handleAdmin(req("GET", "/admin/tokens/99999"), "/admin/tokens/99999");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /admin/tokens/:id", () => {
  beforeEach(resetDb);

  test("updates name and returns the updated token", async () => {
    await handleAdmin(req("POST", "/admin/tokens", { name: "original" }), "/admin/tokens");
    const [{ id }] = await json(await handleAdmin(req("GET", "/admin/tokens"), "/admin/tokens"));

    const res = await handleAdmin(
      req("PATCH", `/admin/tokens/${id}`, { name: "updated" }),
      `/admin/tokens/${id}`,
    );
    expect(res.status).toBe(200);
    expect((await json(res)).name).toBe("updated");
  });

  test("disables a token", async () => {
    await handleAdmin(req("POST", "/admin/tokens", { name: "to-disable" }), "/admin/tokens");
    const [{ id }] = await json(await handleAdmin(req("GET", "/admin/tokens"), "/admin/tokens"));

    const res = await handleAdmin(
      req("PATCH", `/admin/tokens/${id}`, { enabled: false }),
      `/admin/tokens/${id}`,
    );
    expect((await json(res)).enabled).toBe(0);
  });

  test("sets budget to null (unlimited)", async () => {
    await handleAdmin(req("POST", "/admin/tokens", { name: "t", budget_usd: 1.0 }), "/admin/tokens");
    const [{ id }] = await json(await handleAdmin(req("GET", "/admin/tokens"), "/admin/tokens"));

    const res = await handleAdmin(
      req("PATCH", `/admin/tokens/${id}`, { name: "t", budget_usd: null }),
      `/admin/tokens/${id}`,
    );
    expect((await json(res)).budget_usd).toBeNull();
  });
});

describe("DELETE /admin/tokens/:id", () => {
  beforeEach(resetDb);

  test("deletes the token and cascades to requests", async () => {
    await handleAdmin(req("POST", "/admin/tokens", { name: "to-delete" }), "/admin/tokens");
    const [{ id }] = await json(await handleAdmin(req("GET", "/admin/tokens"), "/admin/tokens"));

    // Insert a request row so we can verify cascade
    db.run(
      "INSERT INTO requests (key_id, model, input_count, cache_hits, upstream_count, upstream_tokens, cost_usd) VALUES (?, ?, 1, 0, 1, 10, 0.01)",
      [id, "test-model"],
    );

    const res = await handleAdmin(req("DELETE", `/admin/tokens/${id}`), `/admin/tokens/${id}`);
    expect(res.status).toBe(200);
    expect((await json(res)).ok).toBe(true);

    // Token gone
    const tokens = await json(await handleAdmin(req("GET", "/admin/tokens"), "/admin/tokens"));
    expect(tokens).toHaveLength(0);

    // Request cascade-deleted
    const row = db.query("SELECT * FROM requests WHERE key_id = ?").get(id);
    expect(row).toBeNull();
  });
});

// ── Stats ─────────────────────────────────────────────────────────────────────

describe("GET /admin/stats", () => {
  beforeEach(resetDb);

  test("returns zero stats on an empty database", async () => {
    const res = await handleAdmin(req("GET", "/admin/stats"), "/admin/stats");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.global.total_inputs).toBe(0);
    expect(body.global.cache_hits).toBe(0);
    expect(body.global.total_cost_usd).toBe(0);
    expect(body.cache.total_entries).toBe(0);
  });

  test("aggregates request data correctly", async () => {
    const { lastInsertRowid: keyId } = db.run(
      "INSERT INTO api_keys (key_hash, key_prefix, name) VALUES ('h1', 'p1', 'k')",
    );
    db.run(
      "INSERT INTO requests (key_id, model, input_count, cache_hits, upstream_count, upstream_tokens, cost_usd) VALUES (?, ?, 10, 7, 3, 120, 0.0024)",
      [keyId, "openai/text-embedding-3-small"],
    );

    const body = await json(await handleAdmin(req("GET", "/admin/stats"), "/admin/stats"));
    expect(body.global.total_inputs).toBe(10);
    expect(body.global.cache_hits).toBe(7);
    expect(body.global.upstream_count).toBe(3);
    expect(body.global.total_cost_usd).toBeCloseTo(0.0024);
    expect(body.global.by_model).toHaveLength(1);
    expect(body.global.by_model[0].model).toBe("openai/text-embedding-3-small");
    expect(body.global.daily).toHaveLength(1);
  });
});

// ── Cache ─────────────────────────────────────────────────────────────────────

describe("GET /admin/cache", () => {
  beforeEach(resetDb);

  test("returns empty stats when cache is empty", async () => {
    const res = await handleAdmin(req("GET", "/admin/cache"), "/admin/cache");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.total_entries).toBe(0);
    expect(body.by_model).toEqual([]);
  });

  test("returns cache stats grouped by model", async () => {
    db.run("INSERT INTO embeddings_cache (cache_key, model, embedding, tokens, hit_count) VALUES ('k1','m1','[]',10,5)");
    db.run("INSERT INTO embeddings_cache (cache_key, model, embedding, tokens, hit_count) VALUES ('k2','m1','[]',10,3)");
    db.run("INSERT INTO embeddings_cache (cache_key, model, embedding, tokens, hit_count) VALUES ('k3','m2','[]',20,1)");

    const body = await json(await handleAdmin(req("GET", "/admin/cache"), "/admin/cache"));
    expect(body.total_entries).toBe(3);
    expect(body.total_hits).toBe(9);
    expect(body.by_model).toHaveLength(2);
    const m1 = body.by_model.find((m: any) => m.model === "m1");
    expect(m1.entries).toBe(2);
    expect(m1.hits).toBe(8);
  });
});

describe("DELETE /admin/cache", () => {
  beforeEach(resetDb);

  test("purges all cache entries and reports count", async () => {
    db.run("INSERT INTO embeddings_cache (cache_key, model, embedding, tokens) VALUES ('a','m','[]',0)");
    db.run("INSERT INTO embeddings_cache (cache_key, model, embedding, tokens) VALUES ('b','m','[]',0)");

    const res = await handleAdmin(req("DELETE", "/admin/cache"), "/admin/cache");
    expect(res.status).toBe(200);
    expect((await json(res)).deleted).toBe(2);

    const after = await json(await handleAdmin(req("GET", "/admin/cache"), "/admin/cache"));
    expect(after.total_entries).toBe(0);
  });

  test("returns deleted=0 on an already-empty cache", async () => {
    const body = await json(await handleAdmin(req("DELETE", "/admin/cache"), "/admin/cache"));
    expect(body.deleted).toBe(0);
  });
});
