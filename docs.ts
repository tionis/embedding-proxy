// Serves GET /docs.md  — LLM/human-readable markdown API reference
// Serves GET /openapi.json — OpenAPI 3.1 spec for tooling integration

export function handleDocs(): Response {
  return new Response(DOCS_MD, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

export function handleOpenApi(req: Request): Response {
  const url = new URL(req.url);
  const serverUrl = `${url.protocol}//${url.host}`;
  return Response.json(buildOpenApiSpec(serverUrl));
}

// ─── Markdown reference ────────────────────────────────────────────────────

const DOCS_MD = `\
# Embedding Proxy — API Reference

A caching proxy for text and image embeddings. Text embeddings are forwarded to
OpenRouter; image/text CLIP embeddings are forwarded to immich-machine-learning
runners. Results are cached in SQLite so identical inputs never hit upstream twice.

## Authentication

All embedding and CLIP endpoints require a Bearer token created via the admin panel:

\`\`\`
Authorization: Bearer emb_<token>
\`\`\`

Admin endpoints require the server's \`ADMIN_KEY\`:

\`\`\`
Authorization: Bearer <ADMIN_KEY>
\`\`\`

---

## Text embeddings

### POST /v1/embeddings

Also available at \`POST /api/v1/embeddings\`.

Forwards to OpenRouter. Responses are cached per model+input. Batch requests are
handled per-item — cached items return instantly while only misses go upstream.

**Request (JSON)**

\`\`\`json
{
  "model": "openai/text-embedding-3-small",
  "input": "hello world"
}
\`\`\`

- \`model\` (string, required) — any OpenRouter embedding model ID
- \`input\` (string | string[], required) — one or more texts to embed
- \`encoding_format\` (string, optional) — passed through to OpenRouter

**Response (JSON)**

\`\`\`json
{
  "object": "list",
  "data": [
    { "object": "embedding", "index": 0, "embedding": [0.0023, -0.0091, 0.0387] }
  ],
  "model": "openai/text-embedding-3-small",
  "usage": { "prompt_tokens": 4, "total_tokens": 4 }
}
\`\`\`

**Errors**

| Status | Meaning |
|--------|---------|
| 401 | Missing or invalid API key |
| 429 | Upstream budget exceeded (cached inputs still served) |
| 502 | OpenRouter returned an error |
| 503 | \`OPENROUTER_API_KEY\` not configured on the server |

---

## Immich CLIP predict

### POST /ml/predict

Proxy to immich-machine-learning runners for image and text CLIP embeddings.
Uses the same multipart/form-data body format as the immich \`/predict\` endpoint.
Requires \`IMMICH_ML_URLS\` to be configured on the server.

The embedding is cached per model+content (SHA-256 of model name + image bytes or
text string). Cache hits return instantly with no runner involved.

**Request (multipart/form-data)**

Fields:

- \`entries\` (string, required) — JSON string describing the task:
  - For image (visual CLIP): \`{"clip":{"visual":{"modelName":"<model>"}}}\`
  - For text (textual CLIP): \`{"clip":{"textual":{"modelName":"<model>"}}}\`
- \`image\` (file) — image binary, required for visual CLIP
- \`text\` (string) — plain text, required for textual CLIP

**Image embedding example**

\`\`\`bash
curl /ml/predict \\
  -H "Authorization: Bearer emb_your_token" \\
  -F 'entries={"clip":{"visual":{"modelName":"ViT-SO400M-16-SigLIP2-384__webli"}}}' \\
  -F 'image=@photo.jpg'
\`\`\`

**Text (CLIP textual) embedding example**

\`\`\`bash
curl /ml/predict \\
  -H "Authorization: Bearer emb_your_token" \\
  -F 'entries={"clip":{"textual":{"modelName":"ViT-SO400M-16-SigLIP2-384__webli"}}}' \\
  -F 'text=a photo of a cat'
\`\`\`

**Response (JSON)**

\`\`\`json
{ "clip": [0.0231, -0.0104, 0.0387] }
\`\`\`

Visual requests served from the runner also include \`imageHeight\` and \`imageWidth\`
(omitted on cache hits).

**Errors**

| Status | Meaning |
|--------|---------|
| 401 | Missing or invalid API key |
| 400 | Malformed body, invalid \`entries\` JSON, or missing \`image\`/\`text\` field |
| 502 | Runner returned an error |
| 503 | \`IMMICH_ML_URLS\` not configured, or all runners currently unhealthy |

---

## Cache hydration

### POST /v1/cache/lookup

Also available at \`POST /api/v1/cache/lookup\`.

Batch-query the cache by pre-computed cache keys. Clients can hash their inputs
locally and check which ones are already cached before sending data over the wire,
reducing upstream bandwidth.

**Cache key format**

Compute the cache key with SHA-256:

| Input type | Key input |
|------------|-----------|
| Text embedding | \`model + "\\x00" + text\` |
| Image CLIP (visual) | \`model + "\\x00image\\x00" + imageBytes\` |
| Text CLIP (textual) | \`model + "\\x00" + text\` |

**Request (JSON)**

\`\`\`json
{
  "keys": [
    "a3f1c2...",
    "7bd094..."
  ]
}
\`\`\`

- \`keys\` (string[], required) — pre-computed hex SHA-256 cache keys

**Response (JSON)**

\`\`\`json
{
  "hits": {
    "a3f1c2...": { "object": "embedding", "embedding": [0.0231, -0.0104] }
  },
  "misses": ["7bd094..."]
}
\`\`\`

**Example (Node.js / image hashing)**

\`\`\`js
import { createHash } from "crypto";
import { readFileSync } from "fs";

const model = "ViT-SO400M-16-SigLIP2-384__webli";
const imageBytes = readFileSync("photo.jpg");
const key = createHash("sha256")
  .update(model + "\\x00image\\x00")
  .update(imageBytes)
  .digest("hex");

const res = await fetch("/v1/cache/lookup", {
  method: "POST",
  headers: { "Authorization": "Bearer emb_...", "Content-Type": "application/json" },
  body: JSON.stringify({ keys: [key] }),
});
const { hits, misses } = await res.json();
// hits[key].embedding — cached vector, or key appears in misses
\`\`\`

**Errors**

| Status | Meaning |
|--------|---------|
| 401 | Missing or invalid API key |
| 400 | \`keys\` missing or not a non-empty array |

---

## Admin API

All admin endpoints require \`Authorization: Bearer <ADMIN_KEY>\`.

### GET /admin/stats

Global usage stats and cache summary.

**Response**

\`\`\`json
{
  "global": {
    "total_requests": 120,
    "total_inputs": 540,
    "total_cache_hits": 310,
    "total_upstream": 230,
    "total_cost_usd": 0.0046
  },
  "cache": { "total_entries": 890, "total_hits": 1204 },
  "daily": [
    { "date": "2026-03-21", "cost_usd": 0.0012, "inputs": 80, "cache_hits": 60 }
  ]
}
\`\`\`

### GET /admin/tokens

List all API keys with per-token usage stats.

### POST /admin/tokens

Create a new API key. The raw key is returned once and never stored.

**Request**

\`\`\`json
{ "name": "my-app", "budget_usd": 5.00 }
\`\`\`

\`budget_usd\` is optional (omit for unlimited).

**Response**

\`\`\`json
{ "id": 1, "key": "emb_..." }
\`\`\`

### GET /admin/tokens/:id

Token detail with per-model usage breakdown.

### PATCH /admin/tokens/:id

Update a token. Any combination of fields:

\`\`\`json
{ "name": "new-name", "enabled": 0, "budget_usd": 10.0 }
\`\`\`

Set \`budget_usd\` to \`null\` for unlimited. Set \`enabled\` to \`0\` to disable.

### DELETE /admin/tokens/:id

Delete a token and all its request history (cascades).

### GET /admin/cache

Cache stats grouped by model.

### DELETE /admin/cache

Purge all cached embeddings. They will be re-fetched from upstream on next use.

---

## Caching behaviour

- Text embeddings: cache key = SHA-256(\`model + "\\x00" + input_text\`)
- Image CLIP: cache key = SHA-256(\`model + "\\x00image\\x00" + image_bytes\`)
- Text CLIP: cache key = SHA-256(\`model + "\\x00" + text\`)
- Cache hits bypass upstream entirely and do not count against any budget.
- A token's \`budget_usd\` is only debited for upstream (non-cached) calls.

## Runner selection (immich CLIP)

Configure via env vars:

- \`IMMICH_ML_URLS\` — comma-separated list of runner base URLs, e.g. \`http://runner1:3003,http://runner2:3003\`
- \`IMMICH_ML_STRATEGY\` — \`first-healthy\` (default, same as immich) or \`round-robin\`
- \`IMMICH_ML_HEALTH_INTERVAL\` — seconds between \`GET /ping\` health checks (default: 30)
`;

// ─── OpenAPI 3.1 spec ──────────────────────────────────────────────────────

function buildOpenApiSpec(serverUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Embedding Proxy",
      version: "1.0.0",
      description:
        "Caching proxy for text embeddings (via OpenRouter) and image/text CLIP embeddings " +
        "(via immich-machine-learning runners). Identical inputs are served from SQLite cache " +
        "with no upstream call.",
    },
    servers: [{ url: serverUrl }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "API key issued via the admin panel (emb_ prefix). Used for all embedding endpoints.",
        },
        adminAuth: {
          type: "http",
          scheme: "bearer",
          description: "Admin key (ADMIN_KEY env var). Used for all /admin/* endpoints.",
        },
      },
      schemas: {
        EmbeddingObject: {
          type: "object",
          properties: {
            object:    { type: "string", enum: ["embedding"] },
            index:     { type: "integer" },
            embedding: { type: "array", items: { type: "number" } },
          },
          required: ["object", "index", "embedding"],
        },
        EmbeddingsResponse: {
          type: "object",
          properties: {
            object: { type: "string", enum: ["list"] },
            data:   { type: "array", items: { $ref: "#/components/schemas/EmbeddingObject" } },
            model:  { type: "string" },
            usage: {
              type: "object",
              properties: {
                prompt_tokens: { type: "integer" },
                total_tokens:  { type: "integer" },
              },
              required: ["prompt_tokens", "total_tokens"],
            },
          },
          required: ["object", "data", "model", "usage"],
        },
        ClipResponse: {
          type: "object",
          properties: {
            clip:        { type: "array", items: { type: "number" }, description: "CLIP embedding vector" },
            imageHeight: { type: "integer", description: "Original image height (visual only, omitted on cache hit)" },
            imageWidth:  { type: "integer", description: "Original image width (visual only, omitted on cache hit)" },
          },
          required: ["clip"],
        },
        ApiKey: {
          type: "object",
          properties: {
            id:         { type: "integer" },
            name:       { type: "string" },
            key_prefix: { type: "string" },
            enabled:    { type: "integer", enum: [0, 1] },
            budget_usd: { type: ["number", "null"], description: "null = unlimited" },
            created_at: { type: "string", format: "date-time" },
          },
          required: ["id", "name", "key_prefix", "enabled", "budget_usd", "created_at"],
        },
        Error: {
          type: "object",
          properties: { error: { type: "string" } },
          required: ["error"],
        },
      },
    },
    paths: {
      "/v1/embeddings": {
        post: embeddingsOperation(),
      },
      "/api/v1/embeddings": {
        post: { ...embeddingsOperation(), summary: "Text embeddings (alternate path)" },
      },
      "/ml/predict": {
        post: {
          summary: "Immich CLIP predict (image or text)",
          description:
            "Proxy to immich-machine-learning runners. Same multipart/form-data body as the " +
            "immich /predict endpoint. Cached per model+content. Requires IMMICH_ML_URLS on the server.",
          tags: ["CLIP"],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["entries"],
                  properties: {
                    entries: {
                      type: "string",
                      description:
                        'JSON string. Visual: {"clip":{"visual":{"modelName":"ViT-SO400M-16-SigLIP2-384__webli"}}} ' +
                        '— Textual: {"clip":{"textual":{"modelName":"ViT-SO400M-16-SigLIP2-384__webli"}}}',
                      examples: {
                        visual:   { value: '{"clip":{"visual":{"modelName":"ViT-SO400M-16-SigLIP2-384__webli"}}}' },
                        textual:  { value: '{"clip":{"textual":{"modelName":"ViT-SO400M-16-SigLIP2-384__webli"}}}' },
                      },
                    },
                    image: {
                      type: "string",
                      format: "binary",
                      description: "Image file. Required for visual CLIP.",
                    },
                    text: {
                      type: "string",
                      description: "Plain text. Required for textual CLIP.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "CLIP embedding vector (and image dimensions when served from runner)",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ClipResponse" } } },
            },
            "400": { description: "Malformed body or missing fields", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "401": { description: "Missing or invalid API key",       content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "502": { description: "Runner returned an error",         content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "503": { description: "No runners configured or all unhealthy", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
      "/v1/cache/lookup": {
        post: cacheLookupOperation(),
      },
      "/api/v1/cache/lookup": {
        post: { ...cacheLookupOperation(), summary: "Cache hydration lookup (alternate path)" },
      },
      "/v1/models": {
        get: {
          summary: "List available embedding models",
          description: "Returns commonly used OpenRouter embedding model IDs. Also at /api/v1/models.",
          tags: ["Text embeddings"],
          security: [],
          responses: {
            "200": {
              description: "Model list",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      object: { type: "string", enum: ["list"] },
                      data: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id:     { type: "string" },
                            object: { type: "string", enum: ["model"] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/admin/stats": {
        get: {
          summary: "Global usage and cache stats",
          tags: ["Admin"],
          security: [{ adminAuth: [] }],
          responses: { "200": { description: "Stats object" }, "401": { description: "Unauthorized" } },
        },
      },
      "/admin/tokens": {
        get: {
          summary: "List all API keys",
          tags: ["Admin"],
          security: [{ adminAuth: [] }],
          responses: { "200": { description: "Array of token objects with usage stats" }, "401": { description: "Unauthorized" } },
        },
        post: {
          summary: "Create an API key",
          tags: ["Admin"],
          security: [{ adminAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name:       { type: "string" },
                    budget_usd: { type: "number", description: "Omit for unlimited" },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Created. Returns {id, key} — raw key shown once only." },
            "400": { description: "Missing name" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/admin/tokens/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        get: {
          summary: "Get token detail with per-model breakdown",
          tags: ["Admin"],
          security: [{ adminAuth: [] }],
          responses: { "200": { description: "Token detail" }, "401": { description: "Unauthorized" }, "404": { description: "Not found" } },
        },
        patch: {
          summary: "Update a token",
          tags: ["Admin"],
          security: [{ adminAuth: [] }],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name:       { type: "string" },
                    enabled:    { type: "integer", enum: [0, 1] },
                    budget_usd: { type: ["number", "null"], description: "null = unlimited" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Updated token" }, "401": { description: "Unauthorized" }, "404": { description: "Not found" } },
        },
        delete: {
          summary: "Delete a token and its request history",
          tags: ["Admin"],
          security: [{ adminAuth: [] }],
          responses: { "200": { description: "Deleted" }, "401": { description: "Unauthorized" }, "404": { description: "Not found" } },
        },
      },
      "/admin/cache": {
        get: {
          summary: "Cache stats grouped by model",
          tags: ["Admin"],
          security: [{ adminAuth: [] }],
          responses: { "200": { description: "Cache stats" }, "401": { description: "Unauthorized" } },
        },
        delete: {
          summary: "Purge all cached embeddings",
          tags: ["Admin"],
          security: [{ adminAuth: [] }],
          responses: { "200": { description: "{ deleted: N }" }, "401": { description: "Unauthorized" } },
        },
      },
      "/docs.md": {
        get: {
          summary: "LLM-friendly markdown API reference",
          tags: ["Meta"],
          security: [],
          responses: { "200": { description: "Markdown document", content: { "text/markdown": {} } } },
        },
      },
      "/openapi.json": {
        get: {
          summary: "This OpenAPI spec",
          tags: ["Meta"],
          security: [],
          responses: { "200": { description: "OpenAPI 3.1 JSON", content: { "application/json": {} } } },
        },
      },
    },
  };
}

function cacheLookupOperation() {
  return {
    summary: "Cache hydration lookup",
    description:
      "Batch-query the cache by pre-computed SHA-256 cache keys. " +
      "Clients hash their inputs locally to check which are already cached before sending data over the wire. " +
      "Key format — text/textual CLIP: sha256(model + '\\x00' + text); " +
      "visual CLIP: sha256(model + '\\x00image\\x00' + imageBytes).",
    tags: ["Cache"],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["keys"],
            properties: {
              keys: {
                type: "array",
                items: { type: "string" },
                description: "Pre-computed hex SHA-256 cache keys",
                example: ["a3f1c2d4...", "7bd09400..."],
              },
            },
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Hits and misses",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                hits: {
                  type: "object",
                  additionalProperties: {
                    type: "object",
                    properties: {
                      object:    { type: "string", enum: ["embedding"] },
                      embedding: { type: "array", items: { type: "number" } },
                    },
                    required: ["object", "embedding"],
                  },
                  description: "Map of cache key → embedding for each hit",
                },
                misses: {
                  type: "array",
                  items: { type: "string" },
                  description: "Keys that were not found in the cache",
                },
              },
              required: ["hits", "misses"],
            },
          },
        },
      },
      "400": { description: "keys missing or not a non-empty array", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      "401": { description: "Missing or invalid API key",            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    },
  };
}

function embeddingsOperation() {
  return {
    summary: "Text embeddings",
    description:
      "OpenAI-compatible embeddings endpoint backed by OpenRouter. " +
      "Each input is looked up in cache independently; misses are batched to upstream.",
    tags: ["Text embeddings"],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["model", "input"],
            properties: {
              model:           { type: "string", example: "openai/text-embedding-3-small" },
              input:           { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
              encoding_format: { type: "string", description: "Passed through to OpenRouter" },
            },
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Embedding vectors in OpenAI format",
        content: { "application/json": { schema: { $ref: "#/components/schemas/EmbeddingsResponse" } } },
      },
      "401": { description: "Missing or invalid API key",              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      "429": { description: "Budget exceeded (cache hits still work)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      "502": { description: "OpenRouter returned an error",            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      "503": { description: "OPENROUTER_API_KEY not configured",       content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    },
  };
}
