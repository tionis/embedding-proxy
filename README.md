# embedding-proxy

An OpenAI-compatible embedding proxy with SQLite caching, API key management, and a web dashboard. Sits in front of [OpenRouter](https://openrouter.ai) and serves cached results so you never pay to embed the same text twice.

## Features

- **Drop-in OpenAI replacement** — compatible with any client that calls `/v1/embeddings` (Obsidian, LangChain, llama-index, etc.)
- **Persistent embedding cache** — SHA-256 keyed per model+input, stored in SQLite; cache hits are free and instant
- **Multi-tenant API keys** — issue scoped keys to different apps/users, each with an optional USD spend limit
- **Admin dashboard** — web UI with global stats, per-key breakdowns, cache hit rates, daily cost history, and cache management
- **OpenRouter backend** — supports all embedding models available on OpenRouter (`text-embedding-3-small`, `text-embedding-3-large`, `text-embedding-ada-002`, etc.)
- **CORS enabled** — works directly from browser-based clients

## Quick start

```bash
# Install dependencies
bun install

# Set required env vars
export ADMIN_KEY="your-secret-admin-key"
export OPENROUTER_API_KEY="sk-or-..."

# Run the server
bun run index.ts
```

Server starts on port `8080` by default. Open `http://localhost:8080/` for the admin dashboard.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ADMIN_KEY` | Yes | — | Bearer token for admin API and dashboard |
| `OPENROUTER_API_KEY` | Yes | — | Your OpenRouter API key |
| `PORT` | No | `8080` | Port to listen on |
| `DB_PATH` | No | `./data.db` | Path to the SQLite database file |

## API

The proxy exposes a standard OpenAI embeddings endpoint:

```
POST /v1/embeddings
POST /api/v1/embeddings
```

**Request** — identical to the OpenAI API:

```json
{
  "model": "text-embedding-3-small",
  "input": "your text here"
}
```

`input` can be a string or an array of strings. Each input is looked up in the cache independently, so a batch request may be partially served from cache.

**Authentication** — pass an API key issued via the admin panel:

```
Authorization: Bearer emb_<key>
```

**Response** — identical to the OpenAI API format.

### Admin API

All admin endpoints require `Authorization: Bearer <ADMIN_KEY>`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/stats` | Global usage stats + cache summary |
| `GET` | `/admin/tokens` | List all API keys with usage stats |
| `POST` | `/admin/tokens` | Create a new API key |
| `GET` | `/admin/tokens/:id` | Get a key with per-model breakdown |
| `PATCH` | `/admin/tokens/:id` | Update name, enabled status, or budget |
| `DELETE` | `/admin/tokens/:id` | Delete a key (cascades request history) |
| `GET` | `/admin/cache` | Cache stats by model |
| `DELETE` | `/admin/cache` | Flush the entire embedding cache |

#### Create a key

```bash
curl -X POST http://localhost:8080/admin/tokens \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "budget_usd": 5.00}'
```

`budget_usd` is optional. Omit it for an unlimited key. The raw key is only returned once at creation time.

## How caching works

Each embedding is stored under `SHA-256(model + "\x00" + input_text)`. When a request arrives:

1. Every input string is looked up in the cache.
2. Cache hits are returned immediately (no upstream call, no cost).
3. Cache misses are batched and sent to OpenRouter.
4. Results from OpenRouter are written back to the cache before responding.

The response is always a correctly ordered, complete OpenAI-format embeddings list regardless of the cache hit/miss mix.

## Budget enforcement

If an API key has a `budget_usd` set, the proxy tracks cumulative upstream spend for that key. Once the budget is exceeded, further requests that require upstream calls return HTTP 429. Requests that are fully served from cache always succeed, even over budget.

## Data model

SQLite database with three tables:

- **`api_keys`** — hashed key, name, enabled flag, optional USD budget
- **`requests`** — one row per API call: input count, cache hits, upstream tokens, cost in USD
- **`embeddings_cache`** — the actual cached vectors as JSON blobs, with hit counters

## Stack

- [Bun](https://bun.sh) — runtime, HTTP server, SQLite, bundler
- [OpenRouter](https://openrouter.ai) — upstream embedding provider
