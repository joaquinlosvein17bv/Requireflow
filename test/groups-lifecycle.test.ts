import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { createProject } from "../src/domain/project.ts";
import {
  createWorkItem,
  updateWorkItem,
  type WorkItem,
} from "../src/domain/backlog/work-item.ts";
import { addAcceptanceCriterion } from "../src/domain/backlog/criteria.ts";
import {
  addStoryToIncrement,
  approveIncrement,
  createIncrement,
  incrementReadiness,
  listIncrementStories,
  listIncrements,
  nextIncrement,
  updateIncrement,
} from "../src/domain/backlog/increment.ts";
import {
  acceptIncrement,
  deliverCorrection,
  listFindings,
  listReviews,
  reportDefect,
  startImplementation,
  submitImplementationEvidence,
} from "../src/domain/backlog/review.ts";

const HUMAN = "human:cli";
const ODD = "agent:odd";

describe("Provisional future groups", () => {
  let db: Database;
  let projectId: string;
  let epicId: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    projectId = createProject({ name: "Cartas", mode: "product" }, db).id;
    epicId = createWorkItem({ projectId, kind: "epic", title: "Cartas" }, db).id;
  });

  afterEach(() => {
    db.close();
  });

  function readyStory(title: string): WorkItem {
    let story = createWorkItem(
      { projectId, kind: "story", title, description: `${title}: confirmado`, parentId: epicId },
      db
    );
    story = updateWorkItem(story.id, story.version, { status: "refined" }, "user:test", db);
    return updateWorkItem(story.id, story.version, { status: "ready" }, "user:test", db);
  }

  it("stores every proposed group even when only G01 is refined", () => {
    const g01Story = readyStory("Abrir carta");
    let g01 = createIncrement({ projectId, code: "G01", goal: "Abrir la carta" }, db);
    addStoryToIncrement(g01.id, g01Story.id, "user:test", db);
    addAcceptanceCriterion({ incrementId: g01.id, text: "La carta se abre", actor: HUMAN }, db);
    g01 = updateIncrement(g01.id, g01.version, { status: "en_refinamiento" }, HUMAN, db);
    g01 = updateIncrement(g01.id, g01.version, { status: "listo_para_aprobacion" }, HUMAN, db);

    // Future groups: a draft story, an empty group and a group with only a goal.
    const draftStory = createWorkItem(
      { projectId, kind: "story", title: "Reclamar carta", parentId: epicId },
      db
    );
    const g02 = createIncrement({ projectId, code: "G02", goal: "Reclamar una carta" }, db);
    addStoryToIncrement(g02.id, draftStory.id, "user:test", db);
    const g03 = createIncrement({ projectId, code: "G03" }, db);

    expect(listIncrements(projectId, db)).toHaveLength(3);
    expect(listIncrementStories(g02.id, db)).toHaveLength(1);

    // Future groups are visible but not executable.
    expect(incrementReadiness(g02.id, db).ready).toBe(false);
    expect(incrementReadiness(g03.id, db).ready).toBe(false);

    // G01 is still the next group; future gaps do not block it.
    expect(nextIncrement(projectId, db)!.increment.id).toBe(g01.id);

    // A future group cannot be approved while provisional.
    expect(() =>
      approveIncrement(g02.id, { expectedVersion: g02.version, actor: HUMAN }, db)
    ).toThrow(/cannot be approved/);
  });

  it("allows refining a future group later without touching the approved one", () => {
    const g01Story = readyStory("Abrir carta");
    let g01 = createIncrement({ projectId, code: "G01", goal: "Abrir" }, db);
    addStoryToIncrement(g01.id, g01Story.id, "user:test", db);
    addAcceptanceCriterion({ incrementId: g01.id, text: "Se abre", actor: HUMAN }, db);
    g01 = updateIncrement(g01.id, g01.version, { status: "en_refinamiento" }, HUMAN, db);
    g01 = updateIncrement(g01.id, g01.version, { status: "listo_para_aprobacion" }, HUMAN, db);
    const approved = approveIncrement(g01.id, { expectedVersion: g01.version, actor: HUMAN }, db);

    const futureStory = readyStory("Reclamar");
    let g02 = createIncrement({ projectId, code: "G02", goal: "Reclamar" }, db);
    addStoryToIncrement(g02.id, futureStory.id, "user:test", db);
    addAcceptanceCriterion({ incrementId: g02.id, text: "Se reclama", actor: HUMAN }, db);
    g02 = updateIncrement(g02.id, g02.version, { status: "en_refinamiento" }, HUMAN, db);

    expect(incrementReadiness(g02.id, db).ready).toBe(true);
    expect(approved.approved_revision).toBe(1);
    expect(
      db.query("SELECT status FROM increments WHERE id = ?").get(g01.id)
    ).toEqual({ status: "aprobado" });
  });
});

describe("Iterative defect cycles", () => {
  let db: Database;
  let projectId: string;
  let epicId: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    projectId = createProject({ name: "Cartas", mode: "product" }, db).id;
    epicId = createWorkItem({ projectId, kind: "epic", title: "Cartas" }, db).id;
  });

  afterEach(() => {
    db.close();
  });

  function approvedGroup() {
    let story = createWorkItem(
      {
        projectId,
        kind: "story",
        title: "Abrir carta",
        description: "Abrir la carta confirmada",
        parentId: epicId,
      },
      db
    );
    story = updateWorkItem(story.id, story.version, { status: "refined" }, "user:test", db);
    story = updateWorkItem(story.id, story.version, { status: "ready" }, "user:test", db);

    let group = createIncrement({ projectId, code: "G01", goal: "Abrir" }, db);
    addStoryToIncrement(group.id, story.id, "user:test", db);
    addAcceptanceCriterion({ incrementId: group.id, text: "La carta se abre", actor: HUMAN }, db);
    group = updateIncrement(group.id, group.version, { status: "en_refinamiento" }, HUMAN, db);
    group = updateIncrement(
      group.id,
      group.version,
      { status: "listo_para_aprobacion" },
      HUMAN,
      db
    );
    return approveIncrement(group.id, { expectedVersion: group.version, actor: HUMAN }, db);
  }

  it("keeps three defects, two corrections and a still-failing round in history", () => {
    const group = approvedGroup();
    startImplementation(group.id, ODD, db);
    submitImplementationEvidence({ incrementId: group.id, actor: ODD, evidence: "Round 1" }, db);

    const d1 = reportDefect(
      { incrementId: group.id, actor: HUMAN, description: "Defecto A: no abre" },
      db
    );
    deliverCorrection({ incrementId: group.id, actor: ODD, evidence: "Corrección 1" }, db);

    const d2 = reportDefect(
      { incrementId: group.id, actor: HUMAN, description: "Defecto B: imagen vacía" },
      db
    );
    deliverCorrection({ incrementId: group.id, actor: ODD, evidence: "Corrección 2" }, db);

    const d3 = reportDefect(
      { incrementId: group.id, actor: HUMAN, description: "Defecto C: link roto" },
      db
    );

    // Still failing: the group stays in corrections, not accepted.
    expect(db.query("SELECT status FROM increments WHERE id = ?").get(group.id)).toEqual({
      status: "en_correcciones",
    });
    const ids = [d1.finding.id, d2.finding.id, d3.finding.id];
    expect(new Set(ids).size).toBe(3);

    const allFindings = listReviews(group.id, db).flatMap((review) =>
      listFindings(review.id, db)
    );
    expect(allFindings).toHaveLength(3);
    expect(allFindings.every((finding) => finding.status === "open")).toBe(true);

    // Fourth delivery and human acceptance: history is preserved, not rewritten.
    deliverCorrection({ incrementId: group.id, actor: ODD, evidence: "Corrección 3" }, db);
    const accepted = acceptIncrement(
      {
        incrementId: group.id,
        actor: HUMAN,
        expectedVersion: (db.query("SELECT version v FROM increments WHERE id = ?").get(group.id) as { v: number }).v,
        evidence: "Probado por el usuario",
      },
      db
    );

    expect(accepted.status).toBe("aceptado");
    const reviews = listReviews(group.id, db);
    expect(reviews.map((review) => review.cycle)).toEqual([1, 2, 3, 4]);
    expect(reviews[0]!.evidence).toBe("Round 1");
    expect(reviews.at(-1)!.status).toBe("accepted");

    const resolved = listReviews(group.id, db).flatMap((review) =>
      listFindings(review.id, db)
    );
    expect(resolved).toHaveLength(3);
    expect(resolved.map((finding) => finding.id).sort()).toEqual([...ids].sort());
    expect(resolved.every((finding) => finding.status === "resolved")).toBe(true);
  });

  it("never accepts on behalf of a machine actor", () => {
    const group = approvedGroup();
    startImplementation(group.id, ODD, db);
    submitImplementationEvidence({ incrementId: group.id, actor: ODD, evidence: "ok" }, db);

    expect(() =>
      acceptIncrement(
        {
          incrementId: group.id,
          actor: ODD,
          expectedVersion: (db.query("SELECT version v FROM increments WHERE id = ?").get(group.id) as { v: number }).v,
        },
        db
      )
    ).toThrow(/human-driven/);
    expect(db.query("SELECT status FROM increments WHERE id = ?").get(group.id)).toEqual({
      status: "pendiente_revision_humana",
    });
  });
});
