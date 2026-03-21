import { createHash } from "crypto";
import { db } from "./db";
import { extractBearer, lookupApiKey } from "./auth";
import { cacheKey, getCached, putCached } from "./cache";
import { pickRunner, hasRunners } from "./runners";

type ClipEntry = {
  textual?: { modelName: string; options?: Record<string, unknown> };
  visual?: { modelName: string; options?: Record<string, unknown> };
};

type Entries = {
  clip?: ClipEntry;
};

export async function handleMlPredict(req: Request): Promise<Response> {
  const rawKey = extractBearer(req);
  if (!rawKey) return jsonErr("Missing Authorization header", 401);
  const apiKey = lookupApiKey(rawKey);
  if (!apiKey) return jsonErr("Invalid or disabled API key", 401);

  if (!hasRunners()) return jsonErr("No IMMICH_ML_URLS configured", 503);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonErr("Expected multipart/form-data body", 400);
  }

  const entriesRaw = form.get("entries");
  if (typeof entriesRaw !== "string") return jsonErr("Missing entries field", 400);

  let entries: Entries;
  try {
    entries = JSON.parse(entriesRaw);
  } catch {
    return jsonErr("entries is not valid JSON", 400);
  }

  const clip = entries.clip;
  if (!clip) return jsonErr("Only clip tasks are supported", 400);

  const isTextual = "textual" in clip;
  const pipelineEntry = clip.textual ?? clip.visual;
  const modelName = pipelineEntry?.modelName ?? "unknown";

  // Derive cache key from model name + raw input content
  let key: string;
  if (isTextual) {
    const text = form.get("text");
    if (typeof text !== "string") return jsonErr("Missing text field for textual clip", 400);
    key = cacheKey(modelName, text);
  } else {
    const image = form.get("image");
    if (!(image instanceof File)) return jsonErr("Missing image field for visual clip", 400);
    const bytes = new Uint8Array(await image.arrayBuffer());
    key = createHash("sha256")
      .update(modelName + "\x00image\x00")
      .update(bytes)
      .digest("hex");
  }

  // Cache hit — return embedding only (image dimensions are not stored)
  const cached = getCached(key);
  if (cached) {
    db.run(
      `INSERT INTO requests (key_id, model, input_count, cache_hits, upstream_count, upstream_tokens, cost_usd)
       VALUES (?, ?, 1, 1, 0, 0, 0)`,
      [apiKey.id, modelName],
    );
    return Response.json({ clip: cached.embedding });
  }

  // Cache miss — forward to a runner
  const runnerUrl = pickRunner();
  if (!runnerUrl) return jsonErr("No healthy immich runners available", 503);

  // Rebuild FormData (original was consumed by formData())
  const upstream = new FormData();
  for (const [k, v] of form.entries()) upstream.append(k, v);

  let res: Response;
  try {
    res = await fetch(`${runnerUrl}/predict`, {
      method: "POST",
      body: upstream,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    return jsonErr(`Runner error: ${e.message}`, 502);
  }

  if (!res.ok) {
    const text = await res.text();
    return jsonErr(`Runner ${res.status}: ${text}`, 502);
  }

  const body = await res.json() as { clip?: number[] | string; imageHeight?: number; imageWidth?: number };
  if (!body.clip) return jsonErr("Runner returned no clip embedding", 502);

  const embedding = Array.isArray(body.clip) ? body.clip : JSON.parse(body.clip as string);
  putCached(key, modelName, embedding, 0);

  db.run(
    `INSERT INTO requests (key_id, model, input_count, cache_hits, upstream_count, upstream_tokens, cost_usd)
     VALUES (?, ?, 1, 0, 1, 0, 0)`,
    [apiKey.id, modelName],
  );

  // Return the full runner response (includes imageHeight/imageWidth for visual requests)
  return Response.json(body);
}

function jsonErr(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
