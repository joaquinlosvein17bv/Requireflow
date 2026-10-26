import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { getDatabase } from "../../db/connection.ts";
import { getProject } from "../project.ts";
import { nowIso } from "../time.ts";
import { appendChange, LOCAL_ACTOR } from "../changelog.ts";
import { readIdempotent, writeIdempotent } from "../idempotency.ts";

export type WorkItemKind = "idea" | "epic" | "story";
export type WorkItemStatus = "captured" | "draft" | "refined" | "ready" | "discarded";
export type WorkItemDefinition =
  | "clear"
  | "partial"
  | "unspecified"
  | "deferred"
  | "delegated";
export type WorkItemOrigin = "user" | "derived" | "agent" | "preexisting";
export type WorkItemPriority = "low" | "medium" | "high" | "blocker";

export const WORK_ITEM_KINDS: WorkItemKind[] = ["idea", "epic", "story"];
export const WORK_ITEM_STATUSES: WorkItemStatus[] = [
  "captured",
  "draft",
  "refined",
  "ready",
  "discarded",
];
export const WORK_ITEM_DEFINITIONS: WorkItemDefinition[] = [
  "clear",
  "partial",
  "unspecified",
  "deferred",
  "delegated",
];
export const WORK_ITEM_ORIGINS: WorkItemOrigin[] = ["user", "derived", "agent", "preexisting"];
export const WORK_ITEM_PRIORITIES: WorkItemPriority[] = ["low", "medium", "high", "blocker"];

/**
 * Definition status is not execution status.
 *
 * A planning item moves from raw capture to a refined, ready statement of
 * intent. Whether it was implemented is answered by the increment that owns it,
 * never by a flag on the story, so the two axes cannot drift into each other.
 */
export const LEGAL_ITEM_TRANSITIONS: Record<WorkItemStatus, WorkItemStatus[]> = {
  captured: ["draft", "discarded"],
  draft: ["captured", "refined", "discarded"],
  refined: ["draft", "ready", "discarded"],
  ready: ["refined", "discarded"],
  discarded: ["draft"],
};

export interface WorkItem {
  id: string;
  project_id: string;
  kind: WorkItemKind;
  parent_id: string | null;
  code: string | null;
  title: string;
  original_text: string;
  description: string | null;
  status: WorkItemStatus;
  definition: WorkItemDefinition;
  origin: WorkItemOrigin;
  priority: WorkItemPriority;
  position: number;
  version: number;
  created_at: string;
  updated_at: string;
  refined_at: string | null;
  discarded_at: string | null;
}

export class WorkItemValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkItemValidationError";
  }
}

/** Raised when a caller writes against a version that is no longer current. */
export class WorkItemConflictError extends Error {
  readonly current: WorkItem;

  constructor(current: WorkItem) {
    super(
      `Work item ${current.id} changed since version ${current.version - 1}. Current version: ${current.version}. Reload and retry.`
    );
    this.name = "WorkItemConflictError";
    this.current = current;
  }
}

export function isWorkItemKind(value: unknown): value is WorkItemKind {
  return typeof value === "string" && WORK_ITEM_KINDS.includes(value as WorkItemKind);
}

export function isWorkItemStatus(value: unknown): value is WorkItemStatus {
  return typeof value === "string" && WORK_ITEM_STATUSES.includes(value as WorkItemStatus);
}

export function canTransitionItem(from: WorkItemStatus, to: WorkItemStatus): boolean {
  if (from === to) return true;
  return LEGAL_ITEM_TRANSITIONS[from].includes(to);
}

const MAX_TEXT = 20_000;
const MAX_TITLE = 200;

function requireProject(projectId: string, db: Database) {
  const project = getProject(projectId, db);
  if (!project) {
    throw new WorkItemValidationError(`Project not found with ID: ${projectId}`);
  }
  return project;
}

function cleanText(value: string, field: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkItemValidationError(`"${field}" is required and must be a non-empty string`);
  }
  if (value.length > max) {
    throw new WorkItemValidationError(`"${field}" must be at most ${max} characters`);
  }
  return value;
}

/** Derives a short, searchable title from the literal capture without losing it. */
export function deriveTitle(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const base = firstLine ?? text.trim();
  if (base.length <= 120) return base;
  return `${base.slice(0, 117).trimEnd()}...`;
}

function normalizeForComparison(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Finds an obvious duplicate without discarding the new capture.
 *
 * The user keeps the text they wrote; the caller receives the existing item as
 * a hint so the agent can offer to merge instead of creating noise.
 */
export function findSimilarIdea(
  projectId: string,
  text: string,
  db: Database = getDatabase()
): WorkItem | null {
  const target = normalizeForComparison(text);
  if (target === "") return null;

  const candidates = db
    .query(
      `SELECT * FROM work_items
        WHERE project_id = ? AND kind = 'idea' AND status != 'discarded'`
    )
    .all(projectId) as WorkItem[];

  return (
    candidates.find((item) => normalizeForComparison(item.original_text) === target) ?? null
  );
}

function nextPosition(projectId: string, kind: WorkItemKind, db: Database): number {
  const row = db
    .query("SELECT MAX(position) as max_pos FROM work_items WHERE project_id = ? AND kind = ?")
    .get(projectId, kind) as { max_pos: number | null };
  return (row?.max_pos ?? -1) + 1;
}

/** Codes are stable and never recycled: the suffix is the highest used one plus one. */
function nextCode(projectId: string, kind: WorkItemKind, db: Database): string | null {
  if (kind === "idea") return null;

  const prefix = kind === "epic" ? "E" : "H";
  const digits = kind === "epic" ? 2 : 3;
  const rows = db
    .query("SELECT code FROM work_items WHERE project_id = ? AND kind = ? AND code IS NOT NULL")
    .all(projectId, kind) as Array<{ code: string }>;

  let highest = 0;
  for (const row of rows) {
    const match = row.code.match(/(\d+)$/);
    if (match) highest = Math.max(highest, Number(match[1]));
  }

  return `${prefix}${String(highest + 1).padStart(digits, "0")}`;
}

export function getWorkItem(id: string, db: Database = getDatabase()): WorkItem | null {
  return db.query("SELECT * FROM work_items WHERE id = ?").get(id) as WorkItem | null;
}

export interface ListWorkItemsFilters {
  kind?: WorkItemKind;
  status?: WorkItemStatus;
  parentId?: string | null;
  includeDiscarded?: boolean;
}

export function listWorkItems(
  projectId: string,
  filters: ListWorkItemsFilters = {},
  db: Database = getDatabase()
): WorkItem[] {
  const conditions: string[] = ["project_id = ?"];
  const params: any[] = [projectId];

  if (filters.kind) {
    conditions.push("kind = ?");
    params.push(filters.kind);
  }
  if (filters.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters.parentId !== undefined) {
    if (filters.parentId === null) {
      conditions.push("parent_id IS NULL");
    } else {
      conditions.push("parent_id = ?");
      params.push(filters.parentId);
    }
  }
  if (!filters.includeDiscarded) {
    conditions.push("status != 'discarded'");
  }

  return db
    .query(
      `SELECT * FROM work_items
        WHERE ${conditions.join(" AND ")}
        ORDER BY position ASC, created_at ASC, id ASC`
    )
    .all(...params) as WorkItem[];
}

export interface BacklogTree {
  projectId: string;
  ideas: WorkItem[];
  epics: Array<WorkItem & { stories: WorkItem[] }>;
  stories: WorkItem[];
  ungrouped: WorkItem[];
}

/**
 * One read for the whole planning picture.
 *
 * The same stories are returned under their epic and in the flat list, because
 * the product needs both views (by epic and by experience group) over one
 * record. Nothing is copied: these are the same rows.
 */
export function getBacklogTree(
  projectId: string,
  db: Database = getDatabase()
): BacklogTree {
  requireProject(projectId, db);

  const ideas = listWorkItems(projectId, { kind: "idea" }, db);
  const epics = listWorkItems(projectId, { kind: "epic" }, db);
  const stories = listWorkItems(projectId, { kind: "story" }, db);

  const storiesByEpic = new Map<string, WorkItem[]>();
  for (const story of stories) {
    if (!story.parent_id) continue;
    const bucket = storiesByEpic.get(story.parent_id);
    if (bucket) bucket.push(story);
    else storiesByEpic.set(story.parent_id, [story]);
  }

  return {
    projectId,
    ideas,
    epics: epics.map((epic) => ({ ...epic, stories: storiesByEpic.get(epic.id) ?? [] })),
    stories,
    ungrouped: stories.filter((story) => story.parent_id === null),
  };
}

export interface CreateIdeaInput {
  projectId: string;
  text: string;
  title?: string;
  actor?: string;
  operationKey?: string;
}

export interface CreateIdeaResult {
  item: WorkItem;
  duplicateOf: WorkItem | null;
  deduplicated: boolean;
}

/** Captures a raw idea. It never creates an executable task. */
export function createIdea(
  input: CreateIdeaInput,
  db: Database = getDatabase()
): CreateIdeaResult {
  requireProject(input.projectId, db);

  const replayedId = readIdempotent(input.operationKey, "idea.capture", db);
  if (replayedId) {
    const existing = getWorkItem(replayedId, db);
    if (existing) {
      return { item: existing, duplicateOf: null, deduplicated: true };
    }
  }

  const text = cleanText(input.text, "text", MAX_TEXT);
  const title = input.title
    ? cleanText(input.title, "title", MAX_TITLE)
    : deriveTitle(text);
  const actor = input.actor || LOCAL_ACTOR;
  const timestamp = nowIso();
  const id = crypto.randomUUID();

  const duplicateOf = findSimilarIdea(input.projectId, text, db);

  db.transaction(() => {
    const position = nextPosition(input.projectId, "idea", db);
    db.run(
      `INSERT INTO work_items (
         id, project_id, kind, parent_id, code, title, original_text, description,
         status, definition, origin, priority, position, version,
         created_at, updated_at
       ) VALUES (?, ?, 'idea', NULL, NULL, ?, ?, NULL, 'captured', 'unspecified', 'user', 'medium', ?, 1, ?, ?)`,
      [id, input.projectId, title, text, position, timestamp, timestamp]
    );

    appendChange(
      {
        projectId: input.projectId,
        entityType: "work_item",
        entityId: id,
        action: "idea.captured",
        actor,
        to: "captured",
        payload: { duplicateOf: duplicateOf?.id ?? null },
      },
      db
    );
  }).immediate();

  writeIdempotent(input.operationKey, "idea.capture", id, db);

  const item = getWorkItem(id, db);
  if (!item) {
    throw new WorkItemValidationError(`Idea ${id} could not be read back after insert`);
  }

  return { item, duplicateOf, deduplicated: false };
}

export interface CreateWorkItemInput {
  projectId: string;
  kind: Exclude<WorkItemKind, "idea">;
  title: string;
  originalText?: string;
  description?: string;
  parentId?: string | null;
  origin?: WorkItemOrigin;
  priority?: WorkItemPriority;
  definition?: WorkItemDefinition;
  status?: WorkItemStatus;
  actor?: string;
}

/** Creates an epic or a story. Stories must belong to an epic of the same project. */
export function createWorkItem(
  input: CreateWorkItemInput,
  db: Database = getDatabase()
): WorkItem {
  requireProject(input.projectId, db);

  if (input.kind === "story") {
    if (!input.parentId) {
      throw new WorkItemValidationError(
        "A story requires parentId pointing to an epic of the same project"
      );
    }
    const parent = getWorkItem(input.parentId, db);
    if (!parent) {
      throw new WorkItemValidationError(`Parent work item not found with ID: ${input.parentId}`);
    }
    if (parent.kind !== "epic") {
      throw new WorkItemValidationError(
        `A story parent must be an epic; ${input.parentId} is a ${parent.kind}`
      );
    }
    if (parent.project_id !== input.projectId) {
      throw new WorkItemValidationError(
        `Epic ${input.parentId} belongs to project ${parent.project_id}, not ${input.projectId}`
      );
    }
  } else if (input.parentId) {
    throw new WorkItemValidationError("An epic cannot have a parent");
  }

  const title = cleanText(input.title, "title", MAX_TITLE);
  const originalText = input.originalText ?? input.title;
  const timestamp = nowIso();
  const id = crypto.randomUUID();
  const status = input.status ?? "draft";
  const actor = input.actor || LOCAL_ACTOR;

  db.transaction(() => {
    const code = nextCode(input.projectId, input.kind, db);
    const position = nextPosition(input.projectId, input.kind, db);
    db.run(
      `INSERT INTO work_items (
         id, project_id, kind, parent_id, code, title, original_text, description,
         status, definition, origin, priority, position, version,
         created_at, updated_at, refined_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        id,
        input.projectId,
        input.kind,
        input.parentId ?? null,
        code,
        title,
        originalText,
        input.description ?? null,
        status,
        input.definition ?? "unspecified",
        input.origin ?? "user",
        input.priority ?? "medium",
        position,
        timestamp,
        timestamp,
        status === "refined" || status === "ready" ? timestamp : null,
      ]
    );

    appendChange(
      {
        projectId: input.projectId,
        entityType: "work_item",
        entityId: id,
        action: `${input.kind}.created`,
        actor,
        to: status,
        payload: { code, parentId: input.parentId ?? null },
      },
      db
    );
  }).immediate();

  const item = getWorkItem(id, db);
  if (!item) {
    throw new WorkItemValidationError(`Work item ${id} could not be read back after insert`);
  }
  return item;
}

export interface UpdateWorkItemPatch {
  title?: string;
  description?: string | null;
  status?: WorkItemStatus;
  definition?: WorkItemDefinition;
  priority?: WorkItemPriority;
  position?: number;
  parentId?: string | null;
}

/**
 * Applies a version-guarded patch.
 *
 * Two agents editing the same item must not silently overwrite each other, so
 * the caller supplies the version it read and a mismatch is a conflict, not a
 * last-write-wins update.
 */
export function updateWorkItem(
  id: string,
  expectedVersion: number,
  patch: UpdateWorkItemPatch,
  actor: string = LOCAL_ACTOR,
  db: Database = getDatabase()
): WorkItem {
  const current = getWorkItem(id, db);
  if (!current) {
    throw new WorkItemValidationError(`Work item not found with ID: ${id}`);
  }
  if (expectedVersion !== current.version) {
    throw new WorkItemConflictError(current);
  }

  const fields: string[] = [];
  const values: any[] = [];

  if (patch.title !== undefined) {
    fields.push("title = ?");
    values.push(cleanText(patch.title, "title", MAX_TITLE));
  }
  if (patch.description !== undefined) {
    if (patch.description !== null && patch.description.length > MAX_TEXT) {
      throw new WorkItemValidationError(`"description" must be at most ${MAX_TEXT} characters`);
    }
    fields.push("description = ?");
    values.push(patch.description);
  }
  if (patch.priority !== undefined) {
    if (!WORK_ITEM_PRIORITIES.includes(patch.priority)) {
      throw new WorkItemValidationError(
        `"priority" has an unsupported value "${String(patch.priority)}". Allowed: ${WORK_ITEM_PRIORITIES.join(", ")}.`
      );
    }
    fields.push("priority = ?");
    values.push(patch.priority);
  }
  if (patch.definition !== undefined) {
    if (!WORK_ITEM_DEFINITIONS.includes(patch.definition)) {
      throw new WorkItemValidationError(
        `"definition" has an unsupported value "${String(patch.definition)}". Allowed: ${WORK_ITEM_DEFINITIONS.join(", ")}.`
      );
    }
    fields.push("definition = ?");
    values.push(patch.definition);
  }
  if (patch.position !== undefined) {
    if (!Number.isInteger(patch.position)) {
      throw new WorkItemValidationError(`"position" must be an integer`);
    }
    fields.push("position = ?");
    values.push(patch.position);
  }
  if (patch.parentId !== undefined) {
    if (current.kind !== "story") {
      throw new WorkItemValidationError("Only stories can change parent");
    }
    if (patch.parentId !== null) {
      const parent = getWorkItem(patch.parentId, db);
      if (!parent || parent.kind !== "epic" || parent.project_id !== current.project_id) {
        throw new WorkItemValidationError(
          `Parent ${patch.parentId} must be an epic of project ${current.project_id}`
        );
      }
    }
    fields.push("parent_id = ?");
    values.push(patch.parentId);
  }

  let statusChanged = false;
  if (patch.status !== undefined && patch.status !== current.status) {
    if (!canTransitionItem(current.status, patch.status)) {
      throw new WorkItemValidationError(
        `Illegal transition from '${current.status}' to '${patch.status}' for ${current.kind} ${current.id}. Allowed next states: ${LEGAL_ITEM_TRANSITIONS[current.status].join(", ")}.`
      );
    }
    fields.push("status = ?");
    values.push(patch.status);
    statusChanged = true;

    if (patch.status === "refined" || patch.status === "ready") {
      fields.push("refined_at = COALESCE(refined_at, ?)");
      values.push(nowIso());
    }
    if (patch.status === "discarded") {
      fields.push("discarded_at = ?");
      values.push(nowIso());
    }
  }

  if (fields.length === 0) {
    return current;
  }

  const timestamp = nowIso();
  fields.push("updated_at = ?", "version = version + 1");
  values.push(timestamp);
  values.push(id, current.version);

  const update = (): void => {
    const result = db.run(
      `UPDATE work_items SET ${fields.join(", ")} WHERE id = ? AND version = ?`,
      values
    );
    if (result.changes !== 1) {
      const fresh = getWorkItem(id, db);
      if (fresh) throw new WorkItemConflictError(fresh);
      throw new WorkItemValidationError(`Work item not found with ID: ${id}`);
    }

    appendChange(
      {
        projectId: current.project_id,
        entityType: "work_item",
        entityId: id,
        action: statusChanged ? `${current.kind}.status_changed` : `${current.kind}.updated`,
        actor,
        from: statusChanged ? current.status : null,
        to: statusChanged ? patch.status ?? null : null,
        payload: { fields: Object.keys(patch) },
      },
      db
    );
  };

  db.transaction(update).immediate();

  const updated = getWorkItem(id, db);
  if (!updated) {
    throw new WorkItemValidationError(`Work item ${id} could not be read back after update`);
  }
  return updated;
}

export function discardWorkItem(
  id: string,
  expectedVersion: number,
  reason: string,
  actor: string = LOCAL_ACTOR,
  db: Database = getDatabase()
): WorkItem {
  const current = getWorkItem(id, db);
  if (!current) {
    throw new WorkItemValidationError(`Work item not found with ID: ${id}`);
  }
  if (expectedVersion !== current.version) {
    throw new WorkItemConflictError(current);
  }
  if (!reason || reason.trim() === "") {
    throw new WorkItemValidationError("A discard reason is required");
  }

  const updated = updateWorkItem(id, expectedVersion, { status: "discarded" }, actor, db);
  appendChange(
    {
      projectId: current.project_id,
      entityType: "work_item",
      entityId: id,
      action: `${current.kind}.discarded`,
      actor,
      from: current.status,
      to: "discarded",
      payload: { reason: reason.trim() },
    },
    db
  );
  return updated;
}
