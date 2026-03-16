import { db, type ApiKey } from "./db";
import { createHash } from "crypto";

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "emb_" + Buffer.from(bytes).toString("base64url");
}

export function lookupApiKey(raw: string): ApiKey | null {
  const hash = hashKey(raw);
  return db.query<ApiKey, [string]>(
    "SELECT * FROM api_keys WHERE key_hash = ? AND enabled = 1"
  ).get(hash);
}

export function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice(7).trim();
}

// Returns spent USD and whether the key is within budget.
// Only upstream (non-cached) costs count against the budget.
export function checkBudget(keyId: number, budgetUsd: number | null): { ok: boolean; spent: number } {
  const row = db.query<{ spent: number }, [number]>(
    "SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM requests WHERE key_id = ?"
  ).get(keyId);
  const spent = row?.spent ?? 0;
  if (budgetUsd === null) return { ok: true, spent };
  return { ok: spent < budgetUsd, spent };
}
