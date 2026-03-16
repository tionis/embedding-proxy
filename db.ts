import { Database } from "bun:sqlite";
import { join } from "path";

const DB_PATH = process.env.DB_PATH ?? join(import.meta.dir, "data.db");

export const db = new Database(DB_PATH, { create: true });

db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

// Schema versioning — bump SCHEMA_VERSION when making breaking changes
const SCHEMA_VERSION = 2;
const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;

if (user_version < SCHEMA_VERSION) {
  // Drop old tables if upgrading from v1 (tokens→usd, requests columns changed)
  if (user_version < 2) {
    db.run("DROP TABLE IF EXISTS requests");
    db.run("DROP TABLE IF EXISTS api_keys");
    db.run("DROP TABLE IF EXISTS embeddings_cache");
  }
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

db.run(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash   TEXT    NOT NULL UNIQUE,
    key_prefix TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    budget_usd REAL,                         -- NULL = unlimited, in dollars
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  )
`);

// One row per API call. Tracks cache hits and upstream cost separately.
db.run(`
  CREATE TABLE IF NOT EXISTS requests (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id         INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    model          TEXT    NOT NULL,
    input_count    INTEGER NOT NULL DEFAULT 1,  -- total inputs in the call
    cache_hits     INTEGER NOT NULL DEFAULT 0,  -- how many were served from cache
    upstream_count INTEGER NOT NULL DEFAULT 0,  -- how many went to OpenRouter
    upstream_tokens INTEGER NOT NULL DEFAULT 0, -- tokens reported by OpenRouter
    cost_usd       REAL    NOT NULL DEFAULT 0,  -- USD charged by OpenRouter (0 for fully cached)
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run("CREATE INDEX IF NOT EXISTS idx_requests_key_id ON requests(key_id)");
db.run("CREATE INDEX IF NOT EXISTS idx_requests_model   ON requests(model)");

db.run(`
  CREATE TABLE IF NOT EXISTS embeddings_cache (
    cache_key  TEXT    PRIMARY KEY,
    model      TEXT    NOT NULL,
    embedding  BLOB    NOT NULL,
    tokens     INTEGER NOT NULL DEFAULT 0,
    hit_count  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    last_hit   TEXT
  )
`);

export type ApiKey = {
  id: number;
  key_hash: string;
  key_prefix: string;
  name: string;
  enabled: number;
  budget_usd: number | null;
  created_at: string;
};
