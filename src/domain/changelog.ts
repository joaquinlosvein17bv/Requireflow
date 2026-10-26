import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { getDatabase } from "../db/connection.ts";
import { nowIso } from "./time.ts";

/**
 * Append-only change log for the planning layer.
 *
 * `history` stays what it always was: the permanent snapshot of an archived
 * task. Product decisions, scope approvals and group state changes need their
 * own audit trail, because they outlive any single task and must never be
 * reconstructed from execution data.
 */
export interface ChangeEntry {
  id: string;
  project_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor: string;
  from_value: string | null;
  to_value: string | null;
  payload: string | null;
  created_at: string;
}

export interface AppendChangeInput {
  projectId: string;
  entityType: string;
  entityId: string;
  action: string;
  actor?: string;
  from?: string | null;
  to?: string | null;
  payload?: unknown;
}

/** Actor recorded when a local command runs without an identified human. */
export const LOCAL_ACTOR = "user:local";

/** Actor the agent-facing transports must never impersonate as a human. */
export const AGENT_ACTOR_PREFIX = "agent:";

export function appendChange(
  input: AppendChangeInput,
  db: Database = getDatabase()
): ChangeEntry {
  const entry: ChangeEntry = {
    id: crypto.randomUUID(),
    project_id: input.projectId,
    entity_type: input.entityType,
    entity_id: input.entityId,
    action: input.action,
    actor: input.actor || LOCAL_ACTOR,
    from_value: input.from ?? null,
    to_value: input.to ?? null,
    payload: input.payload === undefined ? null : JSON.stringify(input.payload),
    created_at: nowIso(),
  };

  db.run(
    `INSERT INTO change_log (
       id, project_id, entity_type, entity_id, action, actor,
       from_value, to_value, payload, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id,
      entry.project_id,
      entry.entity_type,
      entry.entity_id,
      entry.action,
      entry.actor,
      entry.from_value,
      entry.to_value,
      entry.payload,
      entry.created_at,
    ]
  );

  return entry;
}

export function listChanges(
  projectId: string,
  limit: number = 50,
  db: Database = getDatabase()
): ChangeEntry[] {
  return db
    .query(
      `SELECT * FROM change_log
        WHERE project_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`
    )
    .all(projectId, Math.min(Math.max(Math.trunc(limit), 1), 500)) as ChangeEntry[];
}

export function listChangesForEntity(
  entityId: string,
  limit: number = 50,
  db: Database = getDatabase()
): ChangeEntry[] {
  return db
    .query(
      `SELECT * FROM change_log
        WHERE entity_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`
    )
    .all(entityId, Math.min(Math.max(Math.trunc(limit), 1), 500)) as ChangeEntry[];
}
