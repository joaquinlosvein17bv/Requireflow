import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { createProject } from "../src/domain/project.ts";
import {
  createWorkItem,
  createIdea,
  promoteIdeaToStory,
  updateWorkItem,
  WorkItemValidationError,
  type WorkItem,
} from "../src/domain/backlog/work-item.ts";
import {
  addAcceptanceCriterion,
  recordDecision,
  retireAcceptanceCriterion,
  supersedeAcceptanceCriterion,
  listAcceptanceCriteria,
} from "../src/domain/backlog/criteria.ts";
import {
  addIncrementDependency,
  addStoryToIncrement,
  approveIncrement,
  createIncrement,
  getIncrement,
  getIncrementView,
  incrementReadiness,
  listIncrementStories,
  nextIncrement,
  removeStoryFromIncrement,
  updateIncrement,
} from "../src/domain/backlog/increment.ts";
import { PlanValidationError } from "../src/domain/backlog/scope.ts";
import {
  acceptIncrement,
  deliverCorrection,
  listFindings,
  listReviews,
  reportDefect,
  startImplementation,
  submitImplementationEvidence,
} from "../src/domain/backlog/review.ts";
import { createTask, getNextTask, getNextTaskDecision, startTask } from "../src/domain/task.ts";

const HUMAN = "human:cli";
const AGENT = "agent:mcp";

describe("Product groups, criteria and the human review loop", () => {
  let db: Database;
  let projectId: string;
  let epicId: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    projectId = createProject({ name: "Cartas", mode: "product" }, db).id;
    epicId = createWorkItem(
      { projectId, kind: "epic", title: "Crear cartas" },
      db
    ).id;
  });

  afterEach(() => {
    db.close();
  });

  function readyStory(title: string, description = `${title}: comportamiento confirmado`): WorkItem {
    let story = createWorkItem(
      { projectId, kind: "story", title, description, parentId: epicId },
      db
    );
    story = updateWorkItem(story.id, story.version, { status: "refined" }, "user:test", db);
    story = updateWorkItem(story.id, story.version, { status: "ready" }, "user:test", db);
    return story;
  }

  function proposedGroup(code: string, stories: WorkItem[], criteria: string[]) {
    let group = createIncrement({ projectId, code, goal: `Objetivo de ${code}` }, db);
    for (const story of stories) addStoryToIncrement(group.id, story.id, "user:test", db);
    for (const text of criteria) {
      addAcceptanceCriterion({ incrementId: group.id, text, actor: "user:test" }, db);
    }
    group = updateIncrement(group.id, group.version, { status: "en_refinamiento" }, "user:test", db);
    group = updateIncrement(
      group.id,
      group.version,
      { status: "listo_para_aprobacion" },
      "user:test",
      db
    );
    return group;
  }

  function approvedGroup(code: string) {
    const story = readyStory(`Historia de ${code}`);
    const group = proposedGroup(code, [story], [`Criterio observable de ${code}`]);
    const approved = approveIncrement(group.id, { expectedVersion: group.version, actor: HUMAN }, db);
    return { group: approved, story };
  }

  describe("readiness", () => {
    it("lists every blocking reason instead of approving an incomplete group", () => {
      const group = createIncrement({ projectId, code: "G01" }, db);
      const readiness = incrementReadiness(group.id, db);

      expect(readiness.ready).toBe(false);
      expect(readiness.blockers).toContain("Falta el objetivo del grupo");
      expect(readiness.blockers).toContain("El grupo no tiene historias");
      expect(readiness.blockers).toContain("Faltan criterios de aceptación");
    });

    it("blocks approval while a story is not refined", () => {
      const draftStory = createWorkItem(
        { projectId, kind: "story", title: "Abrir carta", description: "Abrir", parentId: epicId },
        db
      );
      const group = proposedGroup("G01", [draftStory], ["Se abre la carta"]);

      expect(incrementReadiness(group.id, db).ready).toBe(false);
      expect(() =>
        approveIncrement(group.id, { expectedVersion: group.version, actor: HUMAN }, db)
      ).toThrow(PlanValidationError);
    });

    it("blocks approval when a dependency is not accepted", () => {
      const first = createIncrement({ projectId, code: "G01" }, db);
      const second = approvedGroup("G02");
      addIncrementDependency(second.group.id, first.id, "user:test", db);

      const readiness = incrementReadiness(second.group.id, db);
      expect(readiness.blockers.some((blocker) => blocker.includes("G01"))).toBe(true);
    });
  });

  describe("confirmed data only", () => {
    it("refuses placeholder answers in decisions", () => {
      const group = createIncrement({ projectId, code: "G01" }, db);

      expect(() =>
        recordDecision(
          {
            projectId,
            incrementId: group.id,
            title: "Imagen de portada",
            question: "¿Se elige de un set o se sube?",
            answer: "[NO ESPECIFICADO]",
          },
          db
        )
      ).toThrow(PlanValidationError);

      expect(() =>
        recordDecision(
          {
            projectId,
            incrementId: group.id,
            title: "Imagen de portada",
            question: "¿Se elige de un set o se sube?",
            answer: "TODO",
          },
          db
        )
      ).toThrow(PlanValidationError);
    });

    it("records an answered decision with provenance", () => {
      const group = createIncrement({ projectId, code: "G01" }, db);
      const decision = recordDecision(
        {
          projectId,
          incrementId: group.id,
          title: "Imagen de portada",
          question: "¿Se elige de un set o se sube?",
          answer: "Se elige de un set predefinido",
          actor: HUMAN,
        },
        db
      );

      expect(decision.code).toBe("D001");
      expect(decision.answer).toBe("Se elige de un set predefinido");
      expect(decision.status).toBe("accepted");
    });

    it("refuses placeholder text in a story title", () => {
      expect(() =>
        createWorkItem(
          { projectId, kind: "story", title: "[NO ESPECIFICADO] abrir carta", parentId: epicId },
          db
        )
      ).toThrow(WorkItemValidationError);
    });

    it("refuses to mark a story ready without a description", () => {
      let story = createWorkItem(
        { projectId, kind: "story", title: "Reclamar carta", parentId: epicId },
        db
      );
      story = updateWorkItem(story.id, story.version, { status: "refined" }, "user:test", db);

      expect(() =>
        updateWorkItem(story.id, story.version, { status: "ready" }, "user:test", db)
      ).toThrow(WorkItemValidationError);
    });
  });

  describe("scope approval and drift", () => {
    it("requires a human actor to approve", () => {
      const story = readyStory("Abrir carta");
      const group = proposedGroup("G01", [story], ["Se abre la carta elegida"]);

      expect(() =>
        approveIncrement(group.id, { expectedVersion: group.version, actor: AGENT }, db)
      ).toThrow(/human-driven/);

      const approved = approveIncrement(
        group.id,
        { expectedVersion: group.version, actor: HUMAN },
        db
      );
      expect(approved.status).toBe("aprobado");
      expect(approved.approved_revision).toBe(1);
      expect(approved.approved_scope_hash).toHaveLength(64);
    });

    it("freezes an immutable revision snapshot", () => {
      const { group } = approvedGroup("G01");
      const row = db
        .query("SELECT snapshot, revision FROM increment_revisions WHERE increment_id = ?")
        .get(group.id) as { snapshot: string; revision: number };
      const snapshot = JSON.parse(row.snapshot);

      expect(row.revision).toBe(1);
      expect(snapshot.stories).toHaveLength(1);
      expect(snapshot.criteria).toHaveLength(1);
      expect(snapshot.goal).toContain("G01");
    });

    it("detects drift and blocks execution until re-approval", () => {
      const { group } = approvedGroup("G01");
      const extraStory = readyStory("Carrusel de cartas");
      addStoryToIncrement(group.id, extraStory.id, "user:test", db);

      const view = getIncrementView(group.id, db);
      expect(view.drifted).toBe(true);
      expect(view.canExecute).toBe(false);

      const reapproved = approveIncrement(
        group.id,
        { expectedVersion: getIncrement(group.id, db)!.version, actor: HUMAN },
        db
      );
      expect(reapproved.approved_revision).toBe(2);
      expect(getIncrementView(group.id, db).drifted).toBe(false);
    });

    it("keeps superseded criteria as history and changes the scope hash", () => {
      const { group } = approvedGroup("G01");
      const before = listAcceptanceCriteria(group.id, {}, db)[0]!;

      const replacement = supersedeAcceptanceCriterion(
        before.id,
        before.version,
        "Se abre la carta y se ve el remitente",
        "user:test",
        db
      );
      const active = listAcceptanceCriteria(group.id, {}, db);
      const all = listAcceptanceCriteria(group.id, { includeInactive: true }, db);

      expect(active).toHaveLength(1);
      expect(active[0]!.id).toBe(replacement.id);
      expect(active[0]!.code).not.toBe(before.code);
      expect(all.find((entry) => entry.id === before.id)?.status).toBe("superseded");
      expect(getIncrementView(group.id, db).drifted).toBe(true);
    });

    it("retires a criterion without losing it", () => {
      const { group } = approvedGroup("G01");
      const criterion = listAcceptanceCriteria(group.id, {}, db)[0]!;

      retireAcceptanceCriterion(criterion.id, criterion.version, "Ya no aplica", HUMAN, db);

      expect(listAcceptanceCriteria(group.id, {}, db)).toHaveLength(0);
      expect(
        listAcceptanceCriteria(group.id, { includeInactive: true }, db)[0]!.status
      ).toBe("retired");
    });
  });

  describe("human review loop", () => {
    it("goes from implementation to review, correction and acceptance", () => {
      const { group } = approvedGroup("G01");
      let current = group;

      current = startImplementation(current.id, "agent:odd", db);
      expect(current.status).toBe("en_implementacion");

      const firstReview = submitImplementationEvidence(
        { incrementId: current.id, actor: "agent:odd", evidence: "Suite verde, build ok" },
        db
      );
      expect(firstReview.cycle).toBe(1);
      expect(getIncrement(current.id, db)!.status).toBe("pendiente_revision_humana");

      const { finding } = reportDefect(
        {
          incrementId: current.id,
          actor: HUMAN,
          description: "Abrir una carta sin imagen rompe la vista",
          acceptanceCriterionCode: listAcceptanceCriteria(current.id, {}, db)[0]!.code,
        },
        db
      );
      expect(finding.status).toBe("open");
      expect(getIncrement(current.id, db)!.status).toBe("en_correcciones");

      const secondReview = deliverCorrection(
        { incrementId: current.id, actor: "agent:odd", evidence: "Corregido con fallback" },
        db
      );
      expect(secondReview.cycle).toBe(2);
      expect(getIncrement(current.id, db)!.status).toBe("pendiente_revision_humana");

      const accepted = acceptIncrement(
        {
          incrementId: current.id,
          actor: HUMAN,
          expectedVersion: getIncrement(current.id, db)!.version,
          evidence: "Probado en navegador",
        },
        db
      );
      expect(accepted.status).toBe("aceptado");
      expect(listReviews(current.id, db).at(-1)!.status).toBe("accepted");
      expect(listFindings(firstReview.id, db)[0]!.status).toBe("resolved");
    });

    it("does not accept a group without a human actor", () => {
      const { group } = approvedGroup("G01");
      startImplementation(group.id, "agent:odd", db);
      submitImplementationEvidence({ incrementId: group.id, actor: "agent:odd" }, db);

      expect(() =>
        acceptIncrement(
          {
            incrementId: group.id,
            actor: AGENT,
            expectedVersion: getIncrement(group.id, db)!.version,
          },
          db
        )
      ).toThrow(/human-driven/);
    });

    it("never treats submitted evidence as acceptance", () => {
      const { group } = approvedGroup("G01");
      startImplementation(group.id, "agent:odd", db);
      submitImplementationEvidence({ incrementId: group.id, actor: "agent:odd" }, db);

      expect(getIncrement(group.id, db)!.status).toBe("pendiente_revision_humana");
    });
  });

  describe("next group", () => {
    it("returns G01 until it is accepted, then G02", () => {
      const first = approvedGroup("G01");
      const secondStory = readyStory("Reclamar carta");
      const second = proposedGroup("G02", [secondStory], ["Se reclama la carta"]);

      expect(nextIncrement(projectId, db)!.increment.code).toBe("G01");

      startImplementation(first.group.id, "agent:odd", db);
      submitImplementationEvidence({ incrementId: first.group.id, actor: "agent:odd" }, db);
      acceptIncrement(
        {
          incrementId: first.group.id,
          actor: HUMAN,
          expectedVersion: getIncrement(first.group.id, db)!.version,
        },
        db
      );

      const next = nextIncrement(projectId, db)!;
      expect(next.increment.id).toBe(second.id);
      expect(next.blocked).toBe(false);
    });

    it("reports a blocked next group instead of skipping it", () => {
      const first = createIncrement({ projectId, code: "G01" }, db);
      const second = createIncrement({ projectId, code: "G02" }, db);
      addIncrementDependency(second.id, first.id, "user:test", db);

      const next = nextIncrement(projectId, db)!;
      expect(next.increment.id).toBe(first.id);
    });
  });

  describe("execution gate in product mode", () => {
    it("refuses to create an unlinked task in product mode", () => {
      expect(() => createTask({ projectId, title: "Tarea suelta" }, db)).toThrow(
        PlanValidationError
      );
    });

    it("refuses a task linked to a story of an unapproved group", () => {
      const story = readyStory("Abrir carta");
      proposedGroup("G01", [story], ["Se abre la carta"]);

      expect(() =>
        createTask({ projectId, title: "Implementar abrir", workItemId: story.id }, db)
      ).toThrow(PlanValidationError);
    });

    it("selects and starts the task once the group is approved", () => {
      const { group, story } = approvedGroup("G01");
      const task = createTask(
        { projectId, title: "Implementar abrir", workItemId: story.id },
        db
      );

      expect(getNextTask(projectId, undefined, db)?.id).toBe(task.id);
      expect(startTask(task.id, db)?.status).toBe("in_progress");
      expect(group.status).toBe("aprobado");
    });

    it("blocks the task again when the approved scope drifts", () => {
      const { group, story } = approvedGroup("G01");
      const task = createTask(
        { projectId, title: "Implementar abrir", workItemId: story.id },
        db
      );

      const extra = readyStory("Carrusel");
      addStoryToIncrement(group.id, extra.id, "user:test", db);

      const decision = getNextTaskDecision(projectId, undefined, db);
      expect(decision.nextTask).toBeNull();
      expect(decision.blocked[0]!.reason).toContain("changed after approval");
      expect(() => startTask(task.id, db)).toThrow(PlanValidationError);
    });

    it("keeps the classic behaviour in legacy mode", () => {
      const legacyId = createProject({ name: "Legacy" }, db).id;
      const task = createTask({ projectId: legacyId, title: "Tarea clásica" }, db);

      expect(getNextTask(legacyId, undefined, db)?.id).toBe(task.id);
      expect(startTask(task.id, db)?.status).toBe("in_progress");
    });
  });

  describe("membership history", () => {
    it("keeps removed stories as history and can re-add them", () => {
      const story = readyStory("Abrir carta");
      const group = proposedGroup("G01", [story], ["Se abre"]);
      removeStoryFromIncrement(group.id, story.id, "user:test", db);

      expect(listIncrementStories(group.id, db)).toHaveLength(0);
      const history = db
        .query(
          "SELECT removed_at FROM increment_stories WHERE increment_id = ? AND work_item_id = ?"
        )
        .all(group.id, story.id) as Array<{ removed_at: string | null }>;
      expect(history).toHaveLength(1);
      expect(history[0]!.removed_at).not.toBeNull();

      addStoryToIncrement(group.id, story.id, "user:test", db);
      expect(listIncrementStories(group.id, db)).toHaveLength(1);
    });
  });

  describe("idea promotion", () => {
    it("promotes a captured idea only with a confirmed description", () => {
      const idea = createIdea({ projectId, text: "Carrusel que se detiene al salir" }, db).item;

      expect(() =>
        promoteIdeaToStory(
          { ideaId: idea.id, epicId, title: "Carrusel", description: "TODO" },
          db
        )
      ).toThrow(WorkItemValidationError);

      const story = promoteIdeaToStory(
        { ideaId: idea.id, epicId, title: "Carrusel de cartas" },
        db
      );

      expect(story.kind).toBe("story");
      expect(story.original_text).toBe("Carrusel que se detiene al salir");
      expect(story.status).toBe("draft");
    });
  });
});
