// Runner pool for immich-machine-learning backends.
// Supports first-healthy (immich default) and round-robin strategies.
// Health is determined by periodic GET /ping checks.

export type Strategy = "first-healthy" | "round-robin";

type Runner = {
  url: string;
  healthy: boolean;
};

const urls = (process.env.IMMICH_ML_URLS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

export const strategy: Strategy =
  process.env.IMMICH_ML_STRATEGY === "round-robin" ? "round-robin" : "first-healthy";

const healthIntervalMs = parseInt(process.env.IMMICH_ML_HEALTH_INTERVAL ?? "30") * 1_000;

// All runners start as healthy so the first request doesn't fail before checks complete.
const pool: Runner[] = urls.map(url => ({ url, healthy: true }));

let rrCursor = 0;

async function checkRunner(runner: Runner): Promise<void> {
  try {
    const res = await fetch(`${runner.url}/ping`, { signal: AbortSignal.timeout(5_000) });
    runner.healthy = res.ok;
  } catch {
    runner.healthy = false;
  }
}

if (pool.length > 0) {
  for (const r of pool) checkRunner(r); // non-blocking initial check
  setInterval(() => { for (const r of pool) checkRunner(r); }, healthIntervalMs);
}

export function pickRunner(): string | null {
  const healthy = pool.filter(r => r.healthy);
  if (healthy.length === 0) return null;

  if (strategy === "round-robin") {
    const runner = healthy[rrCursor % healthy.length];
    rrCursor++;
    return runner.url;
  }

  // first-healthy: first in original configured order that is healthy
  return pool.find(r => r.healthy)!.url;
}

export function hasRunners(): boolean {
  return pool.length > 0;
}

export function runnerStatus(): { url: string; healthy: boolean }[] {
  return pool.map(r => ({ url: r.url, healthy: r.healthy }));
}
