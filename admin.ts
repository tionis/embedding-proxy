import { db } from "./db";
import { generateKey, hashKey } from "./auth";

const ADMIN_KEY = process.env.ADMIN_KEY ?? "";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function checkAdmin(req: Request): boolean {
  if (!ADMIN_KEY) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${ADMIN_KEY}`;
}

// --- Token CRUD ---

function listTokens() {
  return db.query<{
    id: number; name: string; key_prefix: string; enabled: number;
    budget_usd: number | null; created_at: string;
    total_requests: number; total_inputs: number;
    cache_hits: number; upstream_count: number;
    upstream_tokens: number; total_cost_usd: number;
  }, []>(`
    SELECT
      k.id, k.name, k.key_prefix, k.enabled, k.budget_usd, k.created_at,
      COUNT(r.id)                        AS total_requests,
      COALESCE(SUM(r.input_count), 0)    AS total_inputs,
      COALESCE(SUM(r.cache_hits), 0)     AS cache_hits,
      COALESCE(SUM(r.upstream_count), 0) AS upstream_count,
      COALESCE(SUM(r.upstream_tokens),0) AS upstream_tokens,
      COALESCE(SUM(r.cost_usd), 0)       AS total_cost_usd
    FROM api_keys k
    LEFT JOIN requests r ON r.key_id = k.id
    GROUP BY k.id
    ORDER BY k.created_at DESC
  `).all();
}

function getToken(id: number) {
  const key = db.query<{
    id: number; name: string; key_prefix: string; enabled: number;
    budget_usd: number | null; created_at: string;
  }, [number]>(
    "SELECT id, name, key_prefix, enabled, budget_usd, created_at FROM api_keys WHERE id = ?"
  ).get(id);
  if (!key) return null;

  const stats = db.query<{
    total_requests: number; total_inputs: number;
    cache_hits: number; upstream_count: number;
    upstream_tokens: number; total_cost_usd: number;
    first_request: string | null; last_request: string | null;
  }, [number]>(`
    SELECT
      COUNT(*)                           AS total_requests,
      COALESCE(SUM(input_count), 0)      AS total_inputs,
      COALESCE(SUM(cache_hits), 0)       AS cache_hits,
      COALESCE(SUM(upstream_count), 0)   AS upstream_count,
      COALESCE(SUM(upstream_tokens), 0)  AS upstream_tokens,
      COALESCE(SUM(cost_usd), 0)         AS total_cost_usd,
      MIN(created_at)                    AS first_request,
      MAX(created_at)                    AS last_request
    FROM requests WHERE key_id = ?
  `).get(id)!;

  const byModel = db.query<{
    model: string; requests: number; total_inputs: number;
    cache_hits: number; upstream_count: number; cost_usd: number;
  }, [number]>(`
    SELECT
      model,
      COUNT(*)                          AS requests,
      COALESCE(SUM(input_count), 0)     AS total_inputs,
      COALESCE(SUM(cache_hits), 0)      AS cache_hits,
      COALESCE(SUM(upstream_count), 0)  AS upstream_count,
      COALESCE(SUM(cost_usd), 0)        AS cost_usd
    FROM requests WHERE key_id = ? GROUP BY model ORDER BY requests DESC
  `).all(id);

  return { ...key, stats, by_model: byModel };
}

function createToken(name: string, budgetUsd?: number | null) {
  const raw = generateKey();
  const hash = hashKey(raw);
  const prefix = raw.slice(0, 12) + "...";
  db.run(
    "INSERT INTO api_keys (key_hash, key_prefix, name, budget_usd) VALUES (?, ?, ?, ?)",
    [hash, prefix, name, budgetUsd ?? null]
  );
  return { key: raw, prefix, name };
}

function updateToken(id: number, fields: { name?: string; enabled?: boolean; budget_usd?: number | null }) {
  const parts: string[] = [];
  const vals: unknown[] = [];
  if (fields.name !== undefined)    { parts.push("name = ?");       vals.push(fields.name); }
  if (fields.enabled !== undefined) { parts.push("enabled = ?");    vals.push(fields.enabled ? 1 : 0); }
  if ("budget_usd" in fields)       { parts.push("budget_usd = ?"); vals.push(fields.budget_usd ?? null); }
  if (parts.length === 0) return false;
  vals.push(id);
  db.run(`UPDATE api_keys SET ${parts.join(", ")} WHERE id = ?`, vals);
  return true;
}

function deleteToken(id: number) {
  db.run("DELETE FROM api_keys WHERE id = ?", [id]);
}

// --- Cache stats ---

function cacheStats() {
  const totals = db.query<{
    total_entries: number; total_hits: number; total_tokens: number;
  }, []>(`
    SELECT COUNT(*)                  AS total_entries,
           COALESCE(SUM(hit_count),0) AS total_hits,
           COALESCE(SUM(tokens), 0)   AS total_tokens
    FROM embeddings_cache
  `).get()!;

  const byModel = db.query<{ model: string; entries: number; hits: number }, []>(`
    SELECT model, COUNT(*) AS entries, COALESCE(SUM(hit_count),0) AS hits
    FROM embeddings_cache GROUP BY model ORDER BY entries DESC
  `).all();

  return { ...totals, by_model: byModel };
}

// --- Global stats ---

function globalStats() {
  const totals = db.query<{
    total_requests: number; total_inputs: number;
    cache_hits: number; upstream_count: number;
    upstream_tokens: number; total_cost_usd: number;
  }, []>(`
    SELECT
      COUNT(*)                          AS total_requests,
      COALESCE(SUM(input_count), 0)     AS total_inputs,
      COALESCE(SUM(cache_hits), 0)      AS cache_hits,
      COALESCE(SUM(upstream_count), 0)  AS upstream_count,
      COALESCE(SUM(upstream_tokens), 0) AS upstream_tokens,
      COALESCE(SUM(cost_usd), 0)        AS total_cost_usd
    FROM requests
  `).get()!;

  const daily = db.query<{
    date: string; requests: number; total_inputs: number;
    cache_hits: number; upstream_count: number; cost_usd: number;
  }, []>(`
    SELECT
      date(created_at)                  AS date,
      COUNT(*)                          AS requests,
      COALESCE(SUM(input_count), 0)     AS total_inputs,
      COALESCE(SUM(cache_hits), 0)      AS cache_hits,
      COALESCE(SUM(upstream_count), 0)  AS upstream_count,
      COALESCE(SUM(cost_usd), 0)        AS cost_usd
    FROM requests GROUP BY date(created_at) ORDER BY date DESC LIMIT 30
  `).all();

  const byModel = db.query<{
    model: string; total_inputs: number; cache_hits: number;
    upstream_count: number; cost_usd: number;
  }, []>(`
    SELECT
      model,
      COALESCE(SUM(input_count), 0)    AS total_inputs,
      COALESCE(SUM(cache_hits), 0)     AS cache_hits,
      COALESCE(SUM(upstream_count), 0) AS upstream_count,
      COALESCE(SUM(cost_usd), 0)       AS cost_usd
    FROM requests GROUP BY model ORDER BY total_inputs DESC
  `).all();

  return { ...totals, daily, by_model: byModel };
}

// --- Router ---

export async function handleAdmin(req: Request, path: string): Promise<Response> {
  if (!checkAdmin(req)) return json({ error: "Unauthorized" }, 401);

  const method = req.method;

  if (method === "GET" && path === "/admin/stats") {
    return json({ global: globalStats(), cache: cacheStats() });
  }

  if (method === "GET" && path === "/admin/cache") {
    return json(cacheStats());
  }

  if (method === "DELETE" && path === "/admin/cache") {
    const result = db.run("DELETE FROM embeddings_cache");
    return json({ deleted: result.changes });
  }

  if (method === "GET" && path === "/admin/tokens") {
    return json(listTokens());
  }

  if (method === "POST" && path === "/admin/tokens") {
    const body = await req.json() as { name?: string; budget_usd?: number };
    if (!body.name) return json({ error: "name is required" }, 400);
    return json(createToken(body.name, body.budget_usd), 201);
  }

  const tokenMatch = path.match(/^\/admin\/tokens\/(\d+)$/);
  if (tokenMatch) {
    const id = parseInt(tokenMatch[1]);

    if (method === "GET") {
      const t = getToken(id);
      return t ? json(t) : json({ error: "Not found" }, 404);
    }

    if (method === "PATCH") {
      const body = await req.json() as { name?: string; enabled?: boolean; budget_usd?: number | null };
      updateToken(id, body);
      const t = getToken(id);
      return t ? json(t) : json({ error: "Not found" }, 404);
    }

    if (method === "DELETE") {
      deleteToken(id);
      return json({ ok: true });
    }
  }

  return json({ error: "Not found" }, 404);
}
