import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { getDatabase } from "../../db/connection.ts";
import { appendChange, LOCAL_ACTOR } from "../changelog.ts";
import { nowIso } from "../time.ts";
import {
  assertConfirmedText,
  assertScopeEditable,
  PlanValidationError,
} from "./scope.ts";

export interface Decision {
  id: string;
  project_id: string;
  increment_id: string | null;
  work_item_id: string | null;
  code: string;
  title: string;
  question: string;
  answer: string;
  alternatives: string | null;
  impact: string | null;
  status: "accepted" | "superseded";
  superseded_by: string | null;
  actor: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface AcceptanceCriterion {
  id: string;
  project_id: string;
  increment_id: string;
  code: string;
  text: string;
  position: number;
  status: "active" | "superseded" | "retired";
  superseded_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface IncrementGuardRow {
  id: string;
  project_id: string;
  code: string;
  status: string;
}

function requireIncrement(incrementId: string, db: Database): IncrementGuardRow {
  const row = db
    .query("SELECT id, project_id, code, status FROM increments WHERE id = ?")
    .get(incrementId) as IncrementGuardRow | null;
  if (!row) {
    throw new PlanValidationError(`Group not found with ID: ${incrementId}`);
  }
  return row;
}

function nextCode(prefix: string, existing: string[], digits: number): string {
  let highest = 0;
  for (const code of existing) {
    const match = code.match(/(\d+)$/);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}${String(highest + 1).padStart(digits, "0")}`;
}

// --- Decisions -------------------------------------------------------------

export interface RecordDecisionInput {
  projectId: string;
  incrementId?: string | null;
  workItemId?: string | null;
  title: string;
  question: string;
  answer: string;
  alternatives?: string;
  impact?: string;
  actor?: string;
}

/**
 * A decision records an answer, never a pending question.
 *
 * Unresolved ambiguities stay in the conversation until the user answers; this
 * function refuses placeholders so they cannot leak into the product record.
 */
export function recordDecision(
  input: RecordDecisionInput,
  db: Database = getDatabase()
): Decision {
  const title = assertConfirmedText(input.title, "title", 200);
  const question = assertConfirmedText(input.question, "question", 2_000);
  const answer = assertConfirmedText(input.answer, "answer", 5_000);

  if (input.incrementId) {
    const increment = requireIncrement(input.incrementId, db);
    assertScopeEditable(increment);
    if (increment.project_id !== input.projectId) {
      throw new PlanValidationError(
        `Group ${increment.code} belongs to project ${increment.project_id}, not ${input.projectId}`
      );
    }
  }

  const existing = (
    db.query("SELECT code FROM decisions WHERE project_id = ?").all(input.projectId) as Array<{
      code: string;
    }>
  ).map((row) => row.code);
  const code = nextCode("D", existing, 3);
  const timestamp = nowIso();
  const id = crypto.randomUUID();
  const actor = input.actor || LOCAL_ACTOR;

  db.transaction(() => {
    db.run(
      `INSERT INTO decisions (
         id, project_id, increment_id, work_item_id, code, title, question, answer,
         alternatives, impact, status, superseded_by, actor, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', NULL, ?, 1, ?, ?)`,
      [
        id,
        input.projectId,
        input.incrementId ?? null,
        input.workItemId ?? null,
        code,
        title,
        question,
        answer,
        input.alternatives ?? null,
        input.impact ?? null,
        actor,
        timestamp,
        timestamp,
      ]
    );
    appendChange(
      {
        projectId: input.projectId,
        entityType: "decision",
        entityId: id,
        action: "decision.recorded",
        actor,
        to: "accepted",
        payload: { code, incrementId: input.incrementId ?? null },
      },
      db
    );
  }).immediate();

  return db.query("SELECT * FROM decisions WHERE id = ?").get(id) as Decision;
}

export function listDecisions(
  projectId: string,
  options: { incrementId?: string; includeSuperseded?: boolean } = {},
  db: Database = getDatabase()
): Decision[] {
  const conditions = ["project_id = ?"];
  const params: any[] = [projectId];
  if (options.incrementId) {
    conditions.push("increment_id = ?");
    params.push(options.incrementId);
  }
  if (!options.includeSuperseded) {
    conditions.push("status = 'accepted'");
  }
  return db
    .query(
      `SELECT * FROM decisions WHERE ${conditions.join(" AND ")} ORDER BY code ASC`
    )
    .all(...params) as Decision[];
}

export function supersedeDecision(
  id: string,
  expectedVersion: number,
  replacementId: string,
  actor: string = LOCAL_ACTOR,
  db: Database = getDatabase()
): Decision {
  const current = db.query("SELECT * FROM decisions WHERE id = ?").get(id) as Decision | null;
  if (!current) throw new PlanValidationError(`Decision not found with ID: ${id}`);
  if (current.version !== expectedVersion) {
    throw new PlanValidationError(
      `Decision ${current.code} changed since version ${expectedVersion}. Current version: ${current.version}.`
    );
  }
  db.run(
    "UPDATE decisions SET status = 'superseded', superseded_by = ?, version = version + 1, updated_at = ? WHERE id = ?",
    [replacementId, nowIso(), id]
  );
  appendChange(
    {
      projectId: current.project_id,
      entityType: "decision",
      entityId: id,
      action: "decision.superseded",
      actor,
      from: "accepted",
      to: "superseded",
      payload: { replacementId },
    },
    db
  );
  return db.query("SELECT * FROM decisions WHERE id = ?").get(id) as Decision;
}

// --- Acceptance criteria ---------------------------------------------------

export function listAcceptanceCriteria(
  incrementId: string,
  options: { includeInactive?: boolean } = {},
  db: Database = getDatabase()
): AcceptanceCriterion[] {
  const condition = options.includeInactive ? "" : " AND status = 'active'";
  return db
    .query(
      `SELECT * FROM acceptance_criteria WHERE increment_id = ?${condition} ORDER BY position ASC, code ASC`
    )
    .all(incrementId) as AcceptanceCriterion[];
}

/**
 * Resolves a criterion by its stable code (`AC-G01-005`) or its id.
 *
 * Scoped to the project so a code owned by another project cannot be used to
 * edit a criterion the caller never read.
 */
export function resolveAcceptanceCriterion(
  projectId: string,
  codeOrId: string,
  db: Database = getDatabase()
): AcceptanceCriterion {
  const value = typeof codeOrId === "string" ? codeOrId.trim() : "";
  if (value === "") {
    throw new PlanValidationError(`"criterion" is required`);
  }
  const row = db
    .query(
      "SELECT * FROM acceptance_criteria WHERE project_id = ? AND (code = ? OR id = ?)"
    )
    .get(projectId, value, value) as AcceptanceCriterion | null;
  if (!row) {
    throw new PlanValidationError(
      `Acceptance criterion not found: ${value}. Pass the AC-<group>-### code or the criterion id.`
    );
  }
  return row;
}

export function addAcceptanceCriterion(
  input: { incrementId: string; text: string; actor?: string; position?: number },
  db: Database = getDatabase()
): AcceptanceCriterion {
  const increment = requireIncrement(input.incrementId, db);
  assertScopeEditable(increment);
  const text = assertConfirmedText(input.text, "text", 2_000);

  const existing = (
    db
      .query("SELECT code, position FROM acceptance_criteria WHERE increment_id = ?")
      .all(increment.id) as Array<{ code: string; position: number }>
  );
  const suffix = nextCode("", existing.map((row) => row.code), 3);
  const code = `AC-${increment.code}-${suffix}`;
  const position =
    input.position ?? existing.reduce((max, row) => Math.max(max, row.position + 1), 0);
  const timestamp = nowIso();
  const id = crypto.randomUUID();
  const actor = input.actor || LOCAL_ACTOR;

  db.transaction(() => {
    db.run(
      `INSERT INTO acceptance_criteria (
         id, project_id, increment_id, code, text, position, status, superseded_by,
         version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, 1, ?, ?)`,
      [id, increment.project_id, increment.id, code, text, position, timestamp, timestamp]
    );
    appendChange(
      {
        projectId: increment.project_id,
        entityType: "acceptance_criterion",
        entityId: id,
        action: "criterion.added",
        actor,
        to: "active",
        payload: { code, incrementId: increment.id },
      },
      db
    );
  }).immediate();

  return db.query("SELECT * FROM acceptance_criteria WHERE id = ?").get(id) as AcceptanceCriterion;
}

/** Replacing a criterion keeps the old one as history and mints a new stable id. */
export function supersedeAcceptanceCriterion(
  id: string,
  expectedVersion: number,
  newText: string,
  actor: string = LOCAL_ACTOR,
  db: Database = getDatabase()
): AcceptanceCriterion {
  const current = db
    .query("SELECT * FROM acceptance_criteria WHERE id = ?")
    .get(id) as AcceptanceCriterion | null;
  if (!current) throw new PlanValidationError(`Acceptance criterion not found with ID: ${id}`);
  if (current.status !== "active") {
    throw new PlanValidationError(`Criterion ${current.code} is already '${current.status}'`);
  }
  if (current.version !== expectedVersion) {
    throw new PlanValidationError(
      `Criterion ${current.code} changed since version ${expectedVersion}. Current version: ${current.version}.`
    );
  }

  const increment = requireIncrement(current.increment_id, db);
  assertScopeEditable(increment);
  const text = assertConfirmedText(newText, "text", 2_000);

  const created = addAcceptanceCriterion(
    { incrementId: increment.id, text, actor, position: current.position },
    db
  );

  db.run(
    "UPDATE acceptance_criteria SET status = 'superseded', superseded_by = ?, version = version + 1, updated_at = ? WHERE id = ?",
    [created.id, nowIso(), id]
  );
  appendChange(
    {
      projectId: current.project_id,
      entityType: "acceptance_criterion",
      entityId: id,
      action: "criterion.superseded",
      actor,
      from: "active",
      to: "superseded",
      payload: { replacementId: created.id, replacementCode: created.code },
    },
    db
  );

  return created;
}

export function retireAcceptanceCriterion(
  id: string,
  expectedVersion: number,
  reason: string,
  actor: string = LOCAL_ACTOR,
  db: Database = getDatabase()
): AcceptanceCriterion {
  const current = db
    .query("SELECT * FROM acceptance_criteria WHERE id = ?")
    .get(id) as AcceptanceCriterion | null;
  if (!current) throw new PlanValidationError(`Acceptance criterion not found with ID: ${id}`);
  if (current.status !== "active") {
    throw new PlanValidationError(`Criterion ${current.code} is already '${current.status}'`);
  }
  if (current.version !== expectedVersion) {
    throw new PlanValidationError(
      `Criterion ${current.code} changed since version ${expectedVersion}. Current version: ${current.version}.`
    );
  }
  const increment = requireIncrement(current.increment_id, db);
  assertScopeEditable(increment);
  const confirmedReason = assertConfirmedText(reason, "reason", 1_000);

  db.run(
    "UPDATE acceptance_criteria SET status = 'retired', version = version + 1, updated_at = ? WHERE id = ?",
    [nowIso(), id]
  );
  appendChange(
    {
      projectId: current.project_id,
      entityType: "acceptance_criterion",
      entityId: id,
      action: "criterion.retired",
      actor,
      from: "active",
      to: "retired",
      payload: { reason: confirmedReason },
    },
    db
  );

  return db
    .query("SELECT * FROM acceptance_criteria WHERE id = ?")
    .get(id) as AcceptanceCriterion;
}
