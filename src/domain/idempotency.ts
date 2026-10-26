import { Database } from "bun:sqlite";
import { getDatabase } from "../db/connection.ts";
import { nowIso } from "./time.ts";

/**
 * Repeated agent operations must not create duplicates.
 *
 * An operation key is scoped to a domain operation so the same user-provided
 * label in two different commands cannot collide. A missing key means "not
 * idempotent": the caller asked for a plain insert.
 */
function scopedKey(scope: string, key: string): string {
  return `${scope}::${key.trim()}`;
}

export function readIdempotent(
  key: string | undefined,
  scope: string,
  db: Database = getDatabase()
): string | null {
  if (key === undefined || key.trim() === "") return null;
  const row = db
    .query("SELECT entity_id FROM idempotency_keys WHERE key = ?")
    .get(scopedKey(scope, key)) as { entity_id: string } | null;
  return row?.entity_id ?? null;
}

export function writeIdempotent(
  key: string | undefined,
  scope: string,
  entityId: string,
  db: Database = getDatabase()
): void {
  if (key === undefined || key.trim() === "") return;
  db.run(
    "INSERT OR IGNORE INTO idempotency_keys (key, scope, entity_id, created_at) VALUES (?, ?, ?, ?)",
    [scopedKey(scope, key), scope, entityId, nowIso()]
  );
}
