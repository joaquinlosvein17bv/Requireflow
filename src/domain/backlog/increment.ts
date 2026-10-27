import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { getDatabase } from "../../db/connection.ts";
import { getProject, type Project } from "../project.ts";
import { appendChange, LOCAL_ACTOR } from "../changelog.ts";
import { nowIso } from "../time.ts";
import {
  assertConfirmedText,
  assertScopeEditable,
  computeScopeHash,
  PlanValidationError,
} from "./scope.ts";
import { getWorkItem, type WorkItem } from "./work-item.ts";
import { listAcceptanceCriteria, listDecisions, type AcceptanceCriterion, type Decision } from "./criteria.ts";

export type IncrementStatus =
  | "planificado"
  | "en_refinamiento"
  | "listo_para_aprobacion"
  | "aprobado"
  | "en_implementacion"
  | "pendiente_revision_humana"
  | "en_correcciones"
  | "aceptado"
  | "bloqueado";

export const INCREMENT_STATUSES: IncrementStatus[] = [
  "planificado",
  "en_refinamiento",
  "listo_para_aprobacion",
  "aprobado",
  "en_implementacion",
  "pendiente_revision_humana",
  "en_correcciones",
  "aceptado",
  "bloqueado",
];

export const LEGAL_INCREMENT_TRANSITIONS: Record<IncrementStatus, IncrementStatus[]> = {
  planificado: ["en_refinamiento", "bloqueado"],
  en_refinamiento: ["listo_para_aprobacion", "planificado", "bloqueado"],
  listo_para_aprobacion: ["aprobado", "en_refinamiento"],
  aprobado: ["en_implementacion", "listo_para_aprobacion", "bloqueado"],
  en_implementacion: ["pendiente_revision_humana", "bloqueado"],
  pendiente_revision_humana: ["aceptado", "en_correcciones"],
  en_correcciones: ["pendiente_revision_humana"],
  aceptado: [],
  bloqueado: ["planificado", "en_refinamiento"],
};

export interface Increment {
  id: string;
  project_id: string;
  code: string;
  name: string | null;
  goal: string | null;
  status: IncrementStatus;
  position: number;
  exclusiones: string | null;
  scope_hash: string | null;
  approved_scope_hash: string | null;
  approved_revision: number;
  approved_at: string | null;
  approved_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export function canTransitionIncrement(from: IncrementStatus, to: IncrementStatus): boolean {
  if (from === to) return true;
  return LEGAL_INCREMENT_TRANSITIONS[from].includes(to);
}

export function getIncrement(id: string, db: Database = getDatabase()): Increment | null {
  return db.query("SELECT * FROM increments WHERE id = ?").get(id) as Increment | null;
}

function requireIncrement(id: string, db: Database): Increment {
  const increment = getIncrement(id, db);
  if (!increment) throw new PlanValidationError(`Group not found with ID: ${id}`);
  return increment;
}

export function getIncrementByCode(
  projectId: string,
  code: string,
  db: Database = getDatabase()
): Increment | null {
  return db
    .query("SELECT * FROM increments WHERE project_id = ? AND code = ?")
    .get(projectId, code.trim().toUpperCase()) as Increment | null;
}

/** Resolves a group by id or by its G## code inside a project. */
export function resolveIncrement(
  projectId: string,
  idOrCode: string,
  db: Database = getDatabase()
): Increment | null {
  return getIncrement(idOrCode, db) ?? getIncrementByCode(projectId, idOrCode, db);
}

export function listIncrements(
  projectId: string,
  db: Database = getDatabase()
): Increment[] {
  return db
    .query("SELECT * FROM increments WHERE project_id = ? ORDER BY position ASC, code ASC")
    .all(projectId) as Increment[];
}

export interface CreateIncrementInput {
  projectId: string;
  code: string;
  name?: string;
  goal?: string;
  exclusiones?: string;
  position?: number;
  actor?: string;
}

export function createIncrement(
  input: CreateIncrementInput,
  db: Database = getDatabase()
): Increment {
  const project = getProject(input.projectId, db);
  if (!project) throw new PlanValidationError(`Project not found with ID: ${input.projectId}`);

  const code = input.code.trim().toUpperCase();
  if (!/^G\d{2,}$/.test(code)) {
    throw new PlanValidationError(`Group code must look like G01, G02, ... Received "${input.code}"`);
  }
  if (getIncrementByCode(project.id, code, db)) {
    throw new PlanValidationError(`Group ${code} already exists in this project`);
  }

  const timestamp = nowIso();
  const id = crypto.randomUUID();
  const actor = input.actor || LOCAL_ACTOR;
  const position =
    input.position ??
    (db.query("SELECT COUNT(*) c FROM increments WHERE project_id = ?").get(project.id) as {
      c: number;
    }).c;

  db.transaction(() => {
    db.run(
      `INSERT INTO increments (
         id, project_id, code, name, goal, status, position, exclusiones,
         scope_hash, approved_scope_hash, approved_revision, approved_at, approved_by,
         version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'planificado', ?, ?, NULL, NULL, 0, NULL, NULL, 1, ?, ?)`,
      [
        id,
        project.id,
        code,
        input.name ?? null,
        input.goal ?? null,
        position,
        input.exclusiones ?? null,
        timestamp,
        timestamp,
      ]
    );
    appendChange(
      {
        projectId: project.id,
        entityType: "increment",
        entityId: id,
        action: "group.created",
        actor,
        to: "planificado",
        payload: { code },
      },
      db
    );
  }).immediate();

  return requireIncrement(id, db);
}

export interface UpdateIncrementPatch {
  name?: string;
  goal?: string;
  exclusiones?: string | null;
  status?: IncrementStatus;
  position?: number;
}

export function updateIncrement(
  incrementId: string,
  expectedVersion: number,
  patch: UpdateIncrementPatch,
  actor: string = LOCAL_ACTOR,
  db: Database = getDatabase()
): Increment {
  const current = requireIncrement(incrementId, db);
  if (current.version !== expectedVersion) {
    throw new PlanValidationError(
      `Group ${current.code} changed since version ${expectedVersion}. Current version: ${current.version}.`
    );
  }

  if (patch.status !== undefined && !canTransitionIncrement(current.status, patch.status)) {
    throw new PlanValidationError(
      `Illegal transition from '${current.status}' to '${patch.status}' for group ${current.code}. Allowed: ${LEGAL_INCREMENT_TRANSITIONS[current.status].join(", ") || "none"}.`
    );
  }

  const fields: string[] = [];
  const values: any[] = [];
  let scopeTouched = false;

  if (patch.name !== undefined) {
    fields.push("name = ?");
    values.push(patch.name);
  }
  if (patch.goal !== undefined) {
    fields.push("goal = ?");
    values.push(assertConfirmedText(patch.goal, "goal", 2_000));
    scopeTouched = true;
  }
  if (patch.exclusiones !== undefined) {
    fields.push("exclusiones = ?");
    values.push(patch.exclusiones);
    scopeTouched = true;
  }
  if (patch.position !== undefined) {
    fields.push("position = ?");
    values.push(patch.position);
  }
  if (scopeTouched) {
    assertScopeEditable(current);
  }
  if (patch.status !== undefined) {
    fields.push("status = ?");
    values.push(patch.status);
  }

  if (fields.length === 0) return current;

  db.run(
    `UPDATE increments SET ${fields.join(", ")}, version = version + 1, updated_at = ? WHERE id = ?`,
    [...values, nowIso(), incrementId]
  );

  appendChange(
    {
      projectId: current.project_id,
      entityType: "increment",
      entityId: incrementId,
      action: patch.status ? "group.status_changed" : "group.updated",
      actor,
      from: patch.status ? current.status : null,
      to: patch.status ?? null,
      payload: { fields: Object.keys(patch) },
    },
    db
  );

  return requireIncrement(incrementId, db);
}

/** Internal status change that still honours the legal transition table. */
export function setIncrementStatus(
  incrementId: string,
  next: IncrementStatus,
  actor: string,
  db: Database = getDatabase()
): Increment {
  const current = requireIncrement(incrementId, db);
  return updateIncrement(incrementId, current.version, { status: next }, actor, db);
}

// --- Membership ------------------------------------------------------------

export function listIncrementStories(
  incrementId: string,
  db: Database = getDatabase()
): WorkItem[] {
  return db
    .query(
      `SELECT w.* FROM increment_stories s
        JOIN work_items w ON w.id = s.work_item_id
       WHERE s.increment_id = ? AND s.removed_at IS NULL
       ORDER BY s.position ASC, w.code ASC, w.id ASC`
    )
    .all(incrementId) as WorkItem[];
}

export function addStoryToIncrement(
  incrementId: string,
  workItemId: string,
  actor: string = LOCAL_ACTOR,
  db: Database = getDatabase()
): void {
  const increment = requireIncrement(incrementId, db);
  assertScopeEditable(increment);

  const story = getWorkItem(workItemId, db);
  if (!story) throw new PlanValidationError(`Work item not found with ID: ${workItemId}`);
  if (story.kind !== "story") {
    throw new PlanValidationError(`Group ${increment.code} accepts stories only; ${story.code ?? story.id} is a ${story.kind}`);
  }
  if (story.project_id !== increment.project_id) {
    throw new PlanValidationError(
      `Story ${story.code ?? story.id} belongs to another project`
    );
  }

  const active = db
    .query(
      "SELECT id FROM increment_stories WHERE increment_id = ? AND work_item_id = ? AND removed_at IS NULL"
    )
    .get(incrementId, workItemId);
  if (active) return;

  const position = (
    db
      .query(
        "SELECT COUNT(*) c FROM increment_stories WHERE increment_id = ? AND removed_at IS NULL"
      )
      .get(incrementId) as { c: number }
  ).c;

  db.transaction(() => {
    db.run(
      "INSERT INTO increment_stories (id, increment_id, work_item_id, position, added_at) VALUES (?, ?, ?, ?, ?)",
      [crypto.randomUUID(), incrementId, workItemId, position, nowIso()]
    );
    appendChange(
      {
        projectId: increment.project_id,
        entityType: "increment_story",
        entityId: incrementId,
        action: "group.story_added",
        actor,
        payload: { workItemId },
      },
      db
    );
  }).immediate();
}

export function removeStoryFromIncrement(
  incrementId: string,
  workItemId: string,
  actor: string = LOCAL_ACTOR,
  db: Database = getDatabase()
): void {
  const increment = requireIncrement(incrementId, db);
  assertScopeEditable(increment);

  const result = db.run(
    "UPDATE increment_stories SET removed_at = ? WHERE increment_id = ? AND work_item_id = ? AND removed_at IS NULL",
    [nowIso(), incrementId, workItemId]
  );
  if (result.changes === 0) {
    throw new PlanValidationError(`Story ${workItemId} is not an active member of ${increment.code}`);
  }
  appendChange(
    {
      projectId: increment.project_id,
      entityType: "increment_story",
      entityId: incrementId,
      action: "group.story_removed",
      actor,
      payload: { workItemId },
    },
    db
  );
}

export function addIncrementDependency(
  incrementId: string,
  dependsOnIncrementId: string,
  actor: string = LOCAL_ACTOR,
  db: Database = getDatabase()
): void {
  const increment = requireIncrement(incrementId, db);
  const dependency = requireIncrement(dependsOnIncrementId, db);
  if (increment.id === dependency.id) {
    throw new PlanValidationError("A group cannot depend on itself");
  }
  if (dependency.project_id !== increment.project_id) {
    throw new PlanValidationError("Dependencies must belong to the same project");
  }
  assertScopeEditable(increment);

  db.run(
    "INSERT OR IGNORE INTO increment_dependencies (increment_id, depends_on_increment_id, created_at) VALUES (?, ?, ?)",
    [incrementId, dependsOnIncrementId, nowIso()]
  );
  appendChange(
    {
      projectId: increment.project_id,
      entityType: "increment_dependency",
      entityId: incrementId,
      action: "group.dependency_added",
      actor,
      payload: { dependsOnIncrementId },
    },
    db
  );
}

export interface IncrementDependency {
  id: string;
  code: string;
  status: IncrementStatus;
}

export function listIncrementDependencies(
  incrementId: string,
  db: Database = getDatabase()
): IncrementDependency[] {
  return db
    .query(
      `SELECT i.id, i.code, i.status FROM increment_dependencies d
        JOIN increments i ON i.id = d.depends_on_increment_id
       WHERE d.increment_id = ? ORDER BY i.code ASC`
    )
    .all(incrementId) as IncrementDependency[];
}

// --- Scope hash, readiness, view ------------------------------------------

export function currentScopeHash(incrementId: string, db: Database = getDatabase()): string {
  const increment = requireIncrement(incrementId, db);
  const stories = listIncrementStories(incrementId, db);
  const criteria = listAcceptanceCriteria(incrementId, {}, db);
  const decisions = listDecisions(increment.project_id, { incrementId }, db);
  return computeScopeHash({
    stories: stories.map((story) => ({ id: story.id, version: story.version })),
    criteria: criteria.map((criterion) => ({ id: criterion.id, version: criterion.version })),
    decisions: decisions.map((decision) => ({ id: decision.id, version: decision.version })),
  });
}

export interface Readiness {
  ready: boolean;
  blockers: string[];
}

export function incrementReadiness(
  incrementId: string,
  db: Database = getDatabase()
): Readiness {
  const increment = requireIncrement(incrementId, db);
  const blockers: string[] = [];

  if (!increment.goal || increment.goal.trim() === "") {
    blockers.push("Falta el objetivo del grupo");
  }

  const stories = listIncrementStories(incrementId, db);
  if (stories.length === 0) {
    blockers.push("El grupo no tiene historias");
  }
  const unrefined = stories.filter((story) => story.status !== "ready");
  if (unrefined.length > 0) {
    blockers.push(
      `Historias sin refinar: ${unrefined.map((story) => story.code ?? story.title).join(", ")}`
    );
  }

  const criteria = listAcceptanceCriteria(incrementId, {}, db);
  if (criteria.length === 0) {
    blockers.push("Faltan criterios de aceptación");
  }

  for (const dependency of listIncrementDependencies(incrementId, db)) {
    if (dependency.status !== "aceptado") {
      blockers.push(`Depende de ${dependency.code}, que no está aceptado (${dependency.status})`);
    }
  }

  return { ready: blockers.length === 0, blockers };
}

export type IncrementNextAction =
  | "refine"
  | "request_approval"
  | "implement"
  | "await_review"
  | "fix"
  | "done"
  | "blocked";

export interface IncrementView {
  increment: Increment;
  stories: WorkItem[];
  acceptanceCriteria: AcceptanceCriterion[];
  decisions: Decision[];
  dependencies: IncrementDependency[];
  readiness: Readiness;
  currentScopeHash: string;
  drifted: boolean;
  canExecute: boolean;
  nextAction: IncrementNextAction;
  latestReview: {
    id: string;
    cycle: number;
    status: "pending" | "changes_requested" | "accepted";
    requested_at: string;
    evidence: string | null;
  } | null;
}

export function getIncrementView(
  incrementId: string,
  db: Database = getDatabase()
): IncrementView {
  const increment = requireIncrement(incrementId, db);
  const stories = listIncrementStories(incrementId, db);
  const criteria = listAcceptanceCriteria(incrementId, {}, db);
  const decisions = listDecisions(increment.project_id, { incrementId }, db);
  const dependencies = listIncrementDependencies(incrementId, db);
  const readiness = incrementReadiness(incrementId, db);
  const scopeHash = currentScopeHash(incrementId, db);
  const drifted =
    increment.approved_scope_hash !== null && increment.approved_scope_hash !== scopeHash;

  const latestReview = db
    .query(
      `SELECT id, cycle, status, requested_at, evidence FROM increment_reviews
        WHERE increment_id = ? ORDER BY cycle DESC LIMIT 1`
    )
    .get(incrementId) as IncrementView["latestReview"];

  const canExecute =
    (increment.status === "aprobado" || increment.status === "en_implementacion") && !drifted;

  let nextAction: IncrementNextAction;
  switch (increment.status) {
    case "aceptado":
      nextAction = "done";
      break;
    case "bloqueado":
      nextAction = "blocked";
      break;
    case "planificado":
    case "en_refinamiento":
      nextAction = "refine";
      break;
    case "listo_para_aprobacion":
      nextAction = "request_approval";
      break;
    case "aprobado":
      nextAction = drifted ? "request_approval" : "implement";
      break;
    case "en_implementacion":
      nextAction = drifted ? "request_approval" : "implement";
      break;
    case "pendiente_revision_humana":
      nextAction = "await_review";
      break;
    case "en_correcciones":
      nextAction = "fix";
      break;
  }

  return {
    increment,
    stories,
    acceptanceCriteria: criteria,
    decisions,
    dependencies,
    readiness,
    currentScopeHash: scopeHash,
    drifted,
    canExecute,
    nextAction,
    latestReview: latestReview ?? null,
  };
}

// --- Approval and execution ------------------------------------------------

export interface ApproveIncrementInput {
  expectedVersion: number;
  actor: string;
}

/**
 * Approves the exact current scope and freezes it as an immutable revision.
 *
 * Only a human-driven channel may call this: the actor must be namespaced
 * `human:`. An agent-supplied `approved_by` is not evidence of approval.
 */
export function approveIncrement(
  incrementId: string,
  input: ApproveIncrementInput,
  db: Database = getDatabase()
): Increment {
  if (!input.actor.startsWith("human:")) {
    throw new PlanValidationError(
      "Scope approval requires a human-driven channel. Agents cannot approve a group."
    );
  }

  const increment = requireIncrement(incrementId, db);
  if (increment.version !== input.expectedVersion) {
    throw new PlanValidationError(
      `Group ${increment.code} changed since version ${input.expectedVersion}. Current version: ${increment.version}.`
    );
  }
  if (!["listo_para_aprobacion", "aprobado"].includes(increment.status)) {
    throw new PlanValidationError(
      `Group ${increment.code} is '${increment.status}' and cannot be approved. It must be 'listo_para_aprobacion'.`
    );
  }

  const readiness = incrementReadiness(incrementId, db);
  if (!readiness.ready) {
    throw new PlanValidationError(
      `Group ${increment.code} is not ready for approval: ${readiness.blockers.join("; ")}`
    );
  }

  const stories = listIncrementStories(incrementId, db);
  const criteria = listAcceptanceCriteria(incrementId, {}, db);
  const decisions = listDecisions(increment.project_id, { incrementId }, db);
  const scopeHash = currentScopeHash(incrementId, db);
  const revision = increment.approved_revision + 1;
  const timestamp = nowIso();

  const snapshot = {
    revision,
    scopeHash,
    goal: increment.goal,
    exclusions: increment.exclusiones,
    stories: stories.map((story) => ({
      id: story.id,
      code: story.code,
      title: story.title,
      version: story.version,
    })),
    criteria: criteria.map((criterion) => ({
      id: criterion.id,
      code: criterion.code,
      text: criterion.text,
      version: criterion.version,
    })),
    decisions: decisions.map((decision) => ({
      id: decision.id,
      code: decision.code,
      question: decision.question,
      answer: decision.answer,
      version: decision.version,
    })),
    approvedAt: timestamp,
    approvedBy: input.actor,
  };

  db.transaction(() => {
    db.run(
      `INSERT INTO increment_revisions (id, increment_id, revision, scope_hash, snapshot, approved_at, approved_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        incrementId,
        revision,
        scopeHash,
        JSON.stringify(snapshot, null, 2),
        timestamp,
        input.actor,
        timestamp,
      ]
    );
    db.run(
      `UPDATE increments
          SET status = 'aprobado', approved_scope_hash = ?, approved_revision = ?,
              approved_at = ?, approved_by = ?, scope_hash = ?,
              version = version + 1, updated_at = ?
        WHERE id = ?`,
      [scopeHash, revision, timestamp, input.actor, scopeHash, timestamp, incrementId]
    );
    appendChange(
      {
        projectId: increment.project_id,
        entityType: "increment",
        entityId: incrementId,
        action: "group.approved",
        actor: input.actor,
        from: increment.status,
        to: "aprobado",
        payload: { revision, scopeHash },
      },
      db
    );
  }).immediate();

  return requireIncrement(incrementId, db);
}

/** Returns the first group that still needs work, with its blocking reasons. */
export function nextIncrement(
  projectId: string,
  db: Database = getDatabase()
): { increment: Increment; blocked: boolean; blockers: string[] } | null {
  const groups = listIncrements(projectId, db);
  for (const group of groups) {
    if (group.status === "aceptado") continue;
    const blockers: string[] = [];
    for (const dependency of listIncrementDependencies(group.id, db)) {
      if (dependency.status !== "aceptado") {
        blockers.push(`${dependency.code} must be accepted first (${dependency.status})`);
      }
    }
    return { increment: group, blocked: blockers.length > 0, blockers };
  }
  return null;
}

export function assertIncrementExecutable(
  increment: Increment,
  db: Database = getDatabase()
): void {
  if (increment.status !== "aprobado" && increment.status !== "en_implementacion") {
    throw new PlanValidationError(
      `Group ${increment.code} is '${increment.status}' and cannot be implemented. It must be approved by a human first.`
    );
  }
  const scopeHash = currentScopeHash(increment.id, db);
  if (increment.approved_scope_hash !== scopeHash) {
    throw new PlanValidationError(
      `Group ${increment.code} changed after approval. Its scope must be approved again before implementation.`
    );
  }
}

/** Groups that currently contain a story, useful for the two views. */
export function listGroupsForStory(
  workItemId: string,
  db: Database = getDatabase()
): Increment[] {
  return db
    .query(
      `SELECT i.* FROM increment_stories s
        JOIN increments i ON i.id = s.increment_id
       WHERE s.work_item_id = ? AND s.removed_at IS NULL
       ORDER BY i.position ASC`
    )
    .all(workItemId) as Increment[];
}

export function assertProjectInProductMode(
  project: Project,
  operation: string
): void {
  if (project.mode !== "product") {
    throw new PlanValidationError(
      `"${operation}" requires product mode. Project "${project.name}" is in legacy mode.`
    );
  }
}

// --- Bulk proposal and refinement -----------------------------------------

export interface ProposedGroup {
  code: string;
  name?: string;
  goal?: string;
  exclusiones?: string;
  storyIds?: string[];
  acceptanceCriteria?: string[];
  dependsOn?: string[];
}

export interface ProposeGroupsResult {
  created: Increment[];
  skipped: string[];
}

/**
 * Persists a whole set of proposed groups atomically.
 *
 * The skill decides the grouping; the domain validates every story, criterion
 * and dependency before writing a single row, and skips codes that already
 * exist instead of duplicating them.
 */
export function proposeGroups(
  projectId: string,
  groups: ProposedGroup[],
  actor: string = LOCAL_ACTOR,
  db: Database = getDatabase()
): ProposeGroupsResult {
  const project = getProject(projectId, db);
  if (!project) throw new PlanValidationError(`Project not found with ID: ${projectId}`);
  if (groups.length === 0) {
    throw new PlanValidationError("A proposal needs at least one group");
  }

  const existingCodes = new Set(
    (
      db.query("SELECT code FROM increments WHERE project_id = ?").all(projectId) as Array<{
        code: string;
      }>
    ).map((row) => row.code)
  );

  const payloadCodes = new Set<string>();
  for (const group of groups) {
    const code = group.code.trim().toUpperCase();
    if (!/^G\d{2,}$/.test(code)) {
      throw new PlanValidationError(`Group code must look like G01, G02, ... Received "${group.code}"`);
    }
    if (payloadCodes.has(code)) {
      throw new PlanValidationError(`Duplicate group code in the proposal: ${code}`);
    }
    payloadCodes.add(code);
    if (group.goal !== undefined) assertConfirmedText(group.goal, `goal of ${code}`, 2_000);
    for (const text of group.acceptanceCriteria ?? []) {
      assertConfirmedText(text, `criterion of ${code}`, 2_000);
    }
    for (const storyId of group.storyIds ?? []) {
      const story = getWorkItem(storyId, db);
      if (!story) throw new PlanValidationError(`Story not found with ID: ${storyId}`);
      if (story.kind !== "story") {
        throw new PlanValidationError(`${storyId} is a ${story.kind}, not a story`);
      }
      if (story.project_id !== projectId) {
        throw new PlanValidationError(`Story ${storyId} belongs to another project`);
      }
    }
  }

  // Dependencies may point to groups in this proposal or to existing groups.
  for (const group of groups) {
    for (const dependencyCode of group.dependsOn ?? []) {
      const code = dependencyCode.trim().toUpperCase();
      if (!payloadCodes.has(code) && !existingCodes.has(code)) {
        throw new PlanValidationError(`Dependency ${code} does not exist in project ${project.name}`);
      }
    }
  }

  const created: Increment[] = [];
  const skipped: string[] = [];
  const timestamp = nowIso();
  const basePosition = (
    db.query("SELECT COUNT(*) c FROM increments WHERE project_id = ?").get(projectId) as {
      c: number;
    }
  ).c;

  db.transaction(() => {
    let offset = 0;
    for (const group of groups) {
      const code = group.code.trim().toUpperCase();
      if (existingCodes.has(code)) {
        skipped.push(code);
        continue;
      }

      const id = crypto.randomUUID();
      db.run(
        `INSERT INTO increments (
           id, project_id, code, name, goal, status, position, exclusiones,
           scope_hash, approved_scope_hash, approved_revision, approved_at, approved_by,
           version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'planificado', ?, ?, NULL, NULL, 0, NULL, NULL, 1, ?, ?)`,
        [
          id,
          projectId,
          code,
          group.name ?? null,
          group.goal ?? null,
          basePosition + offset,
          group.exclusiones ?? null,
          timestamp,
          timestamp,
        ]
      );
      offset += 1;

      (group.storyIds ?? []).forEach((storyId, index) => {
        db.run(
          "INSERT INTO increment_stories (id, increment_id, work_item_id, position, added_at) VALUES (?, ?, ?, ?, ?)",
          [crypto.randomUUID(), id, storyId, index, timestamp]
        );
      });

      (group.acceptanceCriteria ?? []).forEach((text, index) => {
        db.run(
          `INSERT INTO acceptance_criteria (
             id, project_id, increment_id, code, text, position, status, superseded_by,
             version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, 1, ?, ?)`,
          [
            crypto.randomUUID(),
            projectId,
            id,
            `AC-${code}-${String(index + 1).padStart(3, "0")}`,
            text,
            index,
            timestamp,
            timestamp,
          ]
        );
      });

      for (const dependencyCode of group.dependsOn ?? []) {
        const normalized = dependencyCode.trim().toUpperCase();
        const dependency = getIncrementByCode(projectId, normalized, db);
        if (!dependency) {
          throw new PlanValidationError(`Dependency ${normalized} was not created in this proposal`);
        }
        db.run(
          "INSERT OR IGNORE INTO increment_dependencies (increment_id, depends_on_increment_id, created_at) VALUES (?, ?, ?)",
          [id, dependency.id, timestamp]
        );
      }

      appendChange(
        {
          projectId,
          entityType: "increment",
          entityId: id,
          action: "group.proposed",
          actor,
          to: "planificado",
          payload: { code, stories: group.storyIds?.length ?? 0 },
        },
        db
      );

      created.push(getIncrement(id, db)!);
    }
  }).immediate();

  return { created, skipped };
}

export interface RefineIncrementPatch {
  name?: string;
  goal?: string;
  exclusiones?: string | null;
  addStoryIds?: string[];
  removeStoryIds?: string[];
  addDependencyCodes?: string[];
  position?: number;
  status?: IncrementStatus;
}

/**
 * One versioned refinement step: goal, membership and dependencies change
 * together or not at all.
 */
export function refineIncrement(
  incrementId: string,
  expectedVersion: number,
  patch: RefineIncrementPatch,
  actor: string = LOCAL_ACTOR,
  db: Database = getDatabase()
): Increment {
  const increment = requireIncrement(incrementId, db);
  if (increment.version !== expectedVersion) {
    throw new PlanValidationError(
      `Group ${increment.code} changed since version ${expectedVersion}. Current version: ${increment.version}.`
    );
  }
  assertScopeEditable(increment);

  const goal = patch.goal !== undefined ? assertConfirmedText(patch.goal, "goal", 2_000) : undefined;
  const timestamp = nowIso();

  if (patch.status !== undefined && patch.status !== increment.status) {
    if (!canTransitionIncrement(increment.status, patch.status)) {
      throw new PlanValidationError(
        `Illegal transition from '${increment.status}' to '${patch.status}' for group ${increment.code}. Allowed: ${LEGAL_INCREMENT_TRANSITIONS[increment.status].join(", ") || "none"}.`
      );
    }
  }

  db.transaction(() => {
    const fields: string[] = [];
    const values: any[] = [];
    if (patch.name !== undefined) {
      fields.push("name = ?");
      values.push(patch.name);
    }
    if (goal !== undefined) {
      fields.push("goal = ?");
      values.push(goal);
    }
    if (patch.exclusiones !== undefined) {
      fields.push("exclusiones = ?");
      values.push(patch.exclusiones);
    }
    if (patch.position !== undefined) {
      fields.push("position = ?");
      values.push(patch.position);
    }
    if (patch.status !== undefined) {
      fields.push("status = ?");
      values.push(patch.status);
    }
    fields.push("version = version + 1", "updated_at = ?");
    values.push(timestamp, incrementId);
    db.run(`UPDATE increments SET ${fields.join(", ")} WHERE id = ?`, values);

    for (const storyId of patch.addStoryIds ?? []) {
      const story = getWorkItem(storyId, db);
      if (!story) throw new PlanValidationError(`Story not found with ID: ${storyId}`);
      if (story.kind !== "story") {
        throw new PlanValidationError(`${storyId} is a ${story.kind}, not a story`);
      }
      if (story.project_id !== increment.project_id) {
        throw new PlanValidationError(`Story ${storyId} belongs to another project`);
      }
      const active = db
        .query(
          "SELECT id FROM increment_stories WHERE increment_id = ? AND work_item_id = ? AND removed_at IS NULL"
        )
        .get(incrementId, storyId);
      if (active) continue;
      const position = (
        db
          .query(
            "SELECT COUNT(*) c FROM increment_stories WHERE increment_id = ? AND removed_at IS NULL"
          )
          .get(incrementId) as { c: number }
      ).c;
      db.run(
        "INSERT INTO increment_stories (id, increment_id, work_item_id, position, added_at) VALUES (?, ?, ?, ?, ?)",
        [crypto.randomUUID(), incrementId, storyId, position, timestamp]
      );
    }

    for (const storyId of patch.removeStoryIds ?? []) {
      db.run(
        "UPDATE increment_stories SET removed_at = ? WHERE increment_id = ? AND work_item_id = ? AND removed_at IS NULL",
        [timestamp, incrementId, storyId]
      );
    }

    for (const dependencyCode of patch.addDependencyCodes ?? []) {
      const dependency = getIncrementByCode(
        increment.project_id,
        dependencyCode.trim().toUpperCase(),
        db
      );
      if (!dependency) {
        throw new PlanValidationError(`Dependency ${dependencyCode} does not exist`);
      }
      if (dependency.id === incrementId) {
        throw new PlanValidationError("A group cannot depend on itself");
      }
      db.run(
        "INSERT OR IGNORE INTO increment_dependencies (increment_id, depends_on_increment_id, created_at) VALUES (?, ?, ?)",
        [incrementId, dependency.id, timestamp]
      );
    }

    appendChange(
      {
        projectId: increment.project_id,
        entityType: "increment",
        entityId: incrementId,
        action: "group.refined",
        actor,
        payload: {
          addStories: patch.addStoryIds?.length ?? 0,
          removeStories: patch.removeStoryIds?.length ?? 0,
        },
      },
      db
    );
  }).immediate();

  return requireIncrement(incrementId, db);
}
