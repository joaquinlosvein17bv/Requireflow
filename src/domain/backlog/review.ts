import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { getDatabase } from "../../db/connection.ts";
import { appendChange } from "../changelog.ts";
import { nowIso } from "../time.ts";
import { PlanValidationError, assertConfirmedText } from "./scope.ts";
import {
  currentScopeHash,
  getIncrement,
  setIncrementStatus,
  type Increment,
} from "./increment.ts";
import { listAcceptanceCriteria } from "./criteria.ts";

export interface IncrementReview {
  id: string;
  increment_id: string;
  revision: number;
  cycle: number;
  status: "pending" | "changes_requested" | "accepted";
  evidence: string | null;
  requested_at: string;
  requested_by: string;
  decided_at: string | null;
  decided_by: string | null;
  notes: string | null;
  version: number;
}

export interface ReviewFinding {
  id: string;
  review_id: string;
  acceptance_criterion_id: string | null;
  kind: "defect" | "observation";
  description: string;
  status: "open" | "resolved";
  created_at: string;
  resolved_at: string | null;
}

export interface ReviewResult {
  id: string;
  review_id: string;
  acceptance_criterion_id: string;
  result: "pass" | "fail";
  evidence: string | null;
  actor: string;
  created_at: string;
}

function requireIncrement(id: string, db: Database): Increment {
  const increment = getIncrement(id, db);
  if (!increment) throw new PlanValidationError(`Group not found with ID: ${id}`);
  return increment;
}

function latestReview(incrementId: string, db: Database): IncrementReview | null {
  return db
    .query(
      "SELECT * FROM increment_reviews WHERE increment_id = ? ORDER BY cycle DESC LIMIT 1"
    )
    .get(incrementId) as IncrementReview | null;
}

export function listReviews(
  incrementId: string,
  db: Database = getDatabase()
): IncrementReview[] {
  return db
    .query("SELECT * FROM increment_reviews WHERE increment_id = ? ORDER BY cycle ASC")
    .all(incrementId) as IncrementReview[];
}

export function listFindings(
  reviewId: string,
  db: Database = getDatabase()
): ReviewFinding[] {
  return db
    .query("SELECT * FROM review_findings WHERE review_id = ? ORDER BY created_at ASC")
    .all(reviewId) as ReviewFinding[];
}

export function listReviewResults(
  reviewId: string,
  db: Database = getDatabase()
): ReviewResult[] {
  return db
    .query("SELECT * FROM review_results WHERE review_id = ? ORDER BY created_at ASC")
    .all(reviewId) as ReviewResult[];
}

function nextCycle(incrementId: string, db: Database): number {
  const row = db
    .query("SELECT COALESCE(MAX(cycle), 0) c FROM increment_reviews WHERE increment_id = ?")
    .get(incrementId) as { c: number };
  return Number(row.c) + 1;
}

export interface SubmitEvidenceInput {
  incrementId: string;
  actor: string;
  notes?: string;
  evidence?: string;
}

/**
 * ODD reports that the implementation is done and technically checked.
 *
 * This moves the group to human review. It never accepts it.
 */
export function submitImplementationEvidence(
  input: SubmitEvidenceInput,
  db: Database = getDatabase()
): IncrementReview {
  const increment = requireIncrement(input.incrementId, db);
  if (increment.status !== "en_implementacion") {
    throw new PlanValidationError(
      `Group ${increment.code} is '${increment.status}'. Evidence can only be submitted while it is 'en_implementacion'.`
    );
  }
  const scopeHash = currentScopeHash(increment.id, db);
  if (increment.approved_scope_hash !== scopeHash) {
    throw new PlanValidationError(
      `Group ${increment.code} changed after approval. Re-approve the scope before submitting evidence.`
    );
  }

  const timestamp = nowIso();
  const review: IncrementReview = {
    id: crypto.randomUUID(),
    increment_id: increment.id,
    revision: increment.approved_revision,
    cycle: nextCycle(increment.id, db),
    status: "pending",
    evidence: input.evidence ?? input.notes ?? null,
    requested_at: timestamp,
    requested_by: input.actor,
    decided_at: null,
    decided_by: null,
    notes: input.notes ?? null,
    version: 1,
  };

  db.transaction(() => {
    db.run(
      `INSERT INTO increment_reviews (
         id, increment_id, revision, cycle, status, evidence, requested_at,
         requested_by, decided_at, decided_by, notes, version
       ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, ?, 1)`,
      [
        review.id,
        review.increment_id,
        review.revision,
        review.cycle,
        review.evidence,
        review.requested_at,
        review.requested_by,
        review.notes,
      ]
    );
    setIncrementStatus(increment.id, "pendiente_revision_humana", input.actor, db);
    appendChange(
      {
        projectId: increment.project_id,
        entityType: "increment",
        entityId: increment.id,
        action: "group.evidence_submitted",
        actor: input.actor,
        from: increment.status,
        to: "pendiente_revision_humana",
        payload: { cycle: review.cycle, revision: review.revision },
      },
      db
    );
  }).immediate();

  return review;
}

export interface ReportDefectInput {
  incrementId: string;
  actor: string;
  description: string;
  acceptanceCriterionCode?: string;
}

/**
 * A defect reopens the same group for correction. It never creates a new story
 * or a new group.
 */
export function reportDefect(
  input: ReportDefectInput,
  db: Database = getDatabase()
): { review: IncrementReview; finding: ReviewFinding } {
  const increment = requireIncrement(input.incrementId, db);
  if (increment.status !== "pendiente_revision_humana") {
    throw new PlanValidationError(
      `Group ${increment.code} is '${increment.status}'. Defects can only be reported while it is 'pendiente_revision_humana'.`
    );
  }
  const description = assertConfirmedText(input.description, "description", 5_000);
  const review = latestReview(increment.id, db);
  if (!review || review.status !== "pending") {
    throw new PlanValidationError(`Group ${increment.code} has no pending review to attach the defect to`);
  }

  let criterionId: string | null = null;
  if (input.acceptanceCriterionCode) {
    const criterion = listAcceptanceCriteria(increment.id, { includeInactive: true }, db).find(
      (entry) => entry.code === input.acceptanceCriterionCode
    );
    if (!criterion) {
      throw new PlanValidationError(
        `Criterion ${input.acceptanceCriterionCode} does not belong to group ${increment.code}`
      );
    }
    criterionId = criterion.id;
  }

  const timestamp = nowIso();
  const finding: ReviewFinding = {
    id: crypto.randomUUID(),
    review_id: review.id,
    acceptance_criterion_id: criterionId,
    kind: "defect",
    description,
    status: "open",
    created_at: timestamp,
    resolved_at: null,
  };

  db.transaction(() => {
    db.run(
      `INSERT INTO review_findings (
         id, review_id, acceptance_criterion_id, kind, description, status, created_at, resolved_at
       ) VALUES (?, ?, ?, 'defect', ?, 'open', ?, NULL)`,
      [finding.id, review.id, criterionId, description, timestamp]
    );
    db.run(
      "UPDATE increment_reviews SET status = 'changes_requested', decided_at = ?, decided_by = ?, version = version + 1 WHERE id = ?",
      [timestamp, input.actor, review.id]
    );
    setIncrementStatus(increment.id, "en_correcciones", input.actor, db);
    appendChange(
      {
        projectId: increment.project_id,
        entityType: "increment",
        entityId: increment.id,
        action: "group.defect_reported",
        actor: input.actor,
        from: increment.status,
        to: "en_correcciones",
        payload: {
          cycle: review.cycle,
          criterion: input.acceptanceCriterionCode ?? null,
          description,
        },
      },
      db
    );
  }).immediate();

  return { review: { ...review, status: "changes_requested" }, finding };
}

export interface DeliverCorrectionInput {
  incrementId: string;
  actor: string;
  evidence?: string;
  notes?: string;
}

/** ODD fixes the reported defect and hands the same group back for review. */
export function deliverCorrection(
  input: DeliverCorrectionInput,
  db: Database = getDatabase()
): IncrementReview {
  const increment = requireIncrement(input.incrementId, db);
  if (increment.status !== "en_correcciones") {
    throw new PlanValidationError(
      `Group ${increment.code} is '${increment.status}'. A correction can only be delivered while it is 'en_correcciones'.`
    );
  }

  const timestamp = nowIso();
  const review: IncrementReview = {
    id: crypto.randomUUID(),
    increment_id: increment.id,
    revision: increment.approved_revision,
    cycle: nextCycle(increment.id, db),
    status: "pending",
    evidence: input.evidence ?? input.notes ?? null,
    requested_at: timestamp,
    requested_by: input.actor,
    decided_at: null,
    decided_by: null,
    notes: input.notes ?? null,
    version: 1,
  };

  db.transaction(() => {
    db.run(
      `INSERT INTO increment_reviews (
         id, increment_id, revision, cycle, status, evidence, requested_at,
         requested_by, decided_at, decided_by, notes, version
       ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, ?, 1)`,
      [
        review.id,
        review.increment_id,
        review.revision,
        review.cycle,
        review.evidence,
        review.requested_at,
        review.requested_by,
        review.notes,
      ]
    );
    setIncrementStatus(increment.id, "pendiente_revision_humana", input.actor, db);
    appendChange(
      {
        projectId: increment.project_id,
        entityType: "increment",
        entityId: increment.id,
        action: "group.correction_delivered",
        actor: input.actor,
        from: increment.status,
        to: "pendiente_revision_humana",
        payload: { cycle: review.cycle },
      },
      db
    );
  }).immediate();

  return review;
}

export interface AcceptIncrementInput {
  incrementId: string;
  actor: string;
  expectedVersion: number;
  evidence?: string;
}

/**
 * The only path to `aceptado`.
 *
 * Requires a human actor, a pending review, and an unchanged approved scope.
 * Tests being green is not acceptance; this call is the human confirmation.
 */
export function acceptIncrement(
  input: AcceptIncrementInput,
  db: Database = getDatabase()
): Increment {
  if (!input.actor.startsWith("human:")) {
    throw new PlanValidationError(
      "Accepting a group requires a human-driven channel. Agents cannot accept on the user's behalf."
    );
  }
  const increment = requireIncrement(input.incrementId, db);
  if (increment.version !== input.expectedVersion) {
    throw new PlanValidationError(
      `Group ${increment.code} changed since version ${input.expectedVersion}. Current version: ${increment.version}.`
    );
  }
  if (increment.status !== "pendiente_revision_humana") {
    throw new PlanValidationError(
      `Group ${increment.code} is '${increment.status}'. Only a group pending human review can be accepted.`
    );
  }
  const scopeHash = currentScopeHash(increment.id, db);
  if (increment.approved_scope_hash !== scopeHash) {
    throw new PlanValidationError(
      `Group ${increment.code} changed after approval. Re-approve the scope before accepting it.`
    );
  }
  const review = latestReview(increment.id, db);
  if (!review || review.status !== "pending") {
    throw new PlanValidationError(`Group ${increment.code} has no pending review to accept`);
  }

  const criteria = listAcceptanceCriteria(increment.id, {}, db);
  const timestamp = nowIso();

  db.transaction(() => {
    for (const criterion of criteria) {
      db.run(
        `INSERT INTO review_results (id, review_id, acceptance_criterion_id, result, evidence, actor, created_at)
         VALUES (?, ?, ?, 'pass', ?, ?, ?)`,
        [crypto.randomUUID(), review.id, criterion.id, input.evidence ?? null, input.actor, timestamp]
      );
    }
    db.run(
      "UPDATE increment_reviews SET status = 'accepted', decided_at = ?, decided_by = ?, version = version + 1 WHERE id = ?",
      [timestamp, input.actor, review.id]
    );
    db.run(
      `UPDATE review_findings
          SET status = 'resolved', resolved_at = ?
        WHERE status = 'open'
          AND review_id IN (SELECT id FROM increment_reviews WHERE increment_id = ?)`,
      [timestamp, increment.id]
    );
    setIncrementStatus(increment.id, "aceptado", input.actor, db);
    appendChange(
      {
        projectId: increment.project_id,
        entityType: "increment",
        entityId: increment.id,
        action: "group.accepted",
        actor: input.actor,
        from: increment.status,
        to: "aceptado",
        payload: { cycle: review.cycle, revision: review.revision, criteria: criteria.length },
      },
      db
    );
  }).immediate();

  return requireIncrement(increment.id, db);
}

/** Starts implementation for an approved, non-drifted group. */
export function startImplementation(
  incrementId: string,
  actor: string,
  db: Database = getDatabase()
): Increment {
  const increment = requireIncrement(incrementId, db);
  if (increment.status !== "aprobado") {
    throw new PlanValidationError(
      `Group ${increment.code} is '${increment.status}'. Only an approved group can start implementation.`
    );
  }
  const scopeHash = currentScopeHash(increment.id, db);
  if (increment.approved_scope_hash !== scopeHash) {
    throw new PlanValidationError(
      `Group ${increment.code} changed after approval. Re-approve the scope before implementation.`
    );
  }
  return setIncrementStatus(incrementId, "en_implementacion", actor, db);
}
