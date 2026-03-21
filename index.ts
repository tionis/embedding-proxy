import { handleEmbeddings } from "./embeddings";
import { handleCacheLookup } from "./cache";
import { handleMlPredict } from "./ml-predict";
import { handleAdmin } from "./admin";
import { handleDocs, handleOpenApi } from "./docs";
import { strategy, runnerStatus } from "./runners";
import dashboard from "./dashboard.html";

const PORT = parseInt(process.env.PORT ?? "8080");
const ADMIN_KEY = process.env.ADMIN_KEY ?? "";

if (!ADMIN_KEY) {
  console.error("FATAL: ADMIN_KEY env var is required");
  process.exit(1);
}
if (!process.env.OPENROUTER_API_KEY) {
  console.warn("WARNING: OPENROUTER_API_KEY not set — upstream requests will fail");
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function preflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

Bun.serve({
  port: PORT,
  routes: {
    // Admin dashboard UI
    "/":        dashboard,
    "/admin":   dashboard,

    // Models list (informational)
    "/v1/models":     { GET: () => modelsResponse(), OPTIONS: preflight },
    "/api/v1/models": { GET: () => modelsResponse(), OPTIONS: preflight },

    // Embeddings proxy (text, via OpenRouter)
    "/v1/embeddings":     { POST: (req) => handleEmbeddings(req).then(withCors), OPTIONS: preflight },
    "/api/v1/embeddings": { POST: (req) => handleEmbeddings(req).then(withCors), OPTIONS: preflight },

    // Cache hydration — query cached embeddings by pre-computed cache keys
    "/v1/cache/lookup":     { POST: (req) => handleCacheLookup(req).then(withCors), OPTIONS: preflight },
    "/api/v1/cache/lookup": { POST: (req) => handleCacheLookup(req).then(withCors), OPTIONS: preflight },

    // Immich ML predict proxy (image/text CLIP, via immich-machine-learning runners)
    "/ml/predict": { POST: (req) => handleMlPredict(req).then(withCors), OPTIONS: preflight },

    // API reference
    "/docs.md":      { GET: () => handleDocs() },
    "/openapi.json": { GET: (req) => handleOpenApi(req) },
  },

  // Admin API (dynamic paths — handled via fetch fallback)
  async fetch(req) {
    if (req.method === "OPTIONS") return preflight();
    const path = new URL(req.url).pathname;
    if (path.startsWith("/admin/")) return withCors(await handleAdmin(req, path));
    return Response.json({ error: "Not found" }, { status: 404, headers: CORS_HEADERS });
  },
});

function modelsResponse() {
  return Response.json({
    object: "list",
    data: [
      { id: "text-embedding-ada-002",       object: "model" },
      { id: "text-embedding-3-small",        object: "model" },
      { id: "text-embedding-3-large",        object: "model" },
      { id: "openai/text-embedding-ada-002", object: "model" },
      { id: "openai/text-embedding-3-small", object: "model" },
      { id: "openai/text-embedding-3-large", object: "model" },
    ],
  });
}

console.log(`Embedding proxy running on port ${PORT}`);
console.log(`Dashboard:  http://localhost:${PORT}/`);
console.log(`Text API:   POST http://localhost:${PORT}/v1/embeddings`);
console.log(`ML predict: POST http://localhost:${PORT}/ml/predict`);

const runners = runnerStatus();
if (runners.length > 0) {
  console.log(`Immich runners (${strategy}): ${runners.map(r => r.url).join(", ")}`);
} else {
  console.log(`Immich runners: none configured (set IMMICH_ML_URLS)`);
}