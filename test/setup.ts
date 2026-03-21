import { db } from "../db";

/** Wipe all rows between tests for isolation. */
export function resetDb() {
  db.run("DELETE FROM requests");
  db.run("DELETE FROM embeddings_cache");
  db.run("DELETE FROM api_keys");
}
