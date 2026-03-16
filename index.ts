import { handleEmbeddings } from "./embeddings";
import { handleAdmin } from "./admin";
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

Bun.serve({
  port: PORT,
  routes: {
    // Admin dashboard UI
    "/":        dashboard,
    "/admin":   dashboard,

    // Models list (informational)
    "/v1/models":     { GET: () => modelsResponse() },
    "/api/v1/models": { GET: () => modelsResponse() },

    // Embeddings proxy
    "/v1/embeddings":     { POST: handleEmbeddings },
    "/api/v1/embeddings": { POST: handleEmbeddings },
  },

  // Admin API (dynamic paths — handled via fetch fallback)
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/admin/")) return handleAdmin(req, path);
    return Response.json({ error: "Not found" }, { status: 404 });
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
console.log(`Dashboard: http://localhost:${PORT}/`);
console.log(`API:       POST http://localhost:${PORT}/v1/embeddings`);