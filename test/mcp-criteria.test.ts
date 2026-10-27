import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { createProject } from "../src/domain/project.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { createWorkItem, updateWorkItem } from "../src/domain/backlog/work-item.ts";
import {
  addStoryToIncrement,
  approveIncrement,
  createIncrement,
  getIncrement,
  getIncrementView,
  incrementReadiness,
  updateIncrement,
} from "../src/domain/backlog/increment.ts";
import { addAcceptanceCriterion, listAcceptanceCriteria } from "../src/domain/backlog/criteria.ts";
import { listChangesForEntity } from "../src/domain/changelog.ts";

const HUMAN = "human:cli";

describe("MCP acceptance criteria lifecycle", () => {
  let db: Database;
  let tools: Record<string, any>;
  let projectId: string;
  let epicId: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    const server = createMcpServer(db);
    tools = (server as any)._registeredTools;
    projectId = createProject({ name: "Cartas", mode: "product" }, db).id;
    epicId = createWorkItem({ projectId, kind: "epic", title: "Cartas" }, db).id;
  });

  afterEach(() => {
    db.close();
  });

  function readyStory() {
    let story = createWorkItem(
      {
        projectId,
        kind: "story",
        title: "Abrir la carta",
        description: "Comportamiento confirmado de la historia",
        parentId: epicId,
      },
      db
    );
    story = updateWorkItem(story.id, story.version, { status: "refined" }, "user:test", db);
    return updateWorkItem(story.id, story.version, { status: "ready" }, "user:test", db);
  }

  function readyGroup(criteria: string[] = ["Criterio observable inicial"]) {
    const story = readyStory();
    let group = createIncrement({ projectId, code: "G01", goal: "Objetivo de G01" }, db);
    addStoryToIncrement(group.id, story.id, "user:test", db);
    for (const text of criteria) {
      addAcceptanceCriterion({ incrementId: group.id, text, actor: "user:test" }, db);
    }
    group = updateIncrement(group.id, group.version, { status: "en_refinamiento" }, "user:test", db);
    return updateIncrement(
      group.id,
      group.version,
      { status: "listo_para_aprobacion" },
      "user:test",
      db
    );
  }

  function approvedGroup(criteria: string[] = ["Criterio observable inicial"]) {
    const group = readyGroup(criteria);
    return approveIncrement(group.id, { expectedVersion: group.version, actor: HUMAN }, db);
  }

  function call(name: string, args: Record<string, unknown>) {
    return tools[name].handler(args);
  }

  it("registers both tools and their aliases", () => {
    for (const name of ["rf_ac_supersede", "ac_supersede", "rf_ac_retire", "ac_retire"]) {
      expect(tools[name]).toBeDefined();
    }
  });

  it("supersedes a criterion by its code and keeps the old one as history", async () => {
    const group = readyGroup();
    const before = listAcceptanceCriteria(group.id, {}, db)[0]!;

    const result = await call("rf_ac_supersede", {
      projectId,
      criterion: before.code,
      expectedVersion: before.version,
      text: "Tras la respuesta correcta se desbloquea el sobre, no el contenido",
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);

    expect(payload.replacement.id).not.toBe(before.id);
    expect(payload.replacement.code).not.toBe(before.code);
    expect(payload.replacement.status).toBe("active");
    expect(payload.superseded.status).toBe("superseded");
    expect(payload.superseded.superseded_by).toBe(payload.replacement.id);
    expect(payload.superseded.version).toBe(before.version + 1);

    const stored = db
      .query("SELECT text FROM acceptance_criteria WHERE id = ?")
      .get(before.id) as { text: string };
    expect(stored.text).toBe(before.text);

    const history = listChangesForEntity(before.id, 10, db);
    expect(history[0]!.action).toBe("criterion.superseded");
    expect(history[0]!.from_value).toBe("active");
    expect(history[0]!.to_value).toBe("superseded");
    expect(JSON.parse(String(history[0]!.payload)).replacementCode).toBe(payload.replacement.code);
  });

  it("retires a criterion by its id and keeps the reason in the change log", async () => {
    const group = readyGroup();
    const before = listAcceptanceCriteria(group.id, {}, db)[0]!;

    const result = await call("rf_ac_retire", {
      projectId,
      criterion: before.id,
      expectedVersion: before.version,
      reason: "Duplicado: ya lo cubre el criterio sucesor",
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);

    expect(payload.retired.id).toBe(before.id);
    expect(payload.retired.status).toBe("retired");
    expect(payload.retired.text).toBe(before.text);
    expect(payload.retired.version).toBe(before.version + 1);

    expect(listAcceptanceCriteria(group.id, {}, db)).toHaveLength(0);
    expect(listAcceptanceCriteria(group.id, { includeInactive: true }, db)[0]!.status).toBe(
      "retired"
    );

    const history = listChangesForEntity(before.id, 10, db);
    expect(history[0]!.action).toBe("criterion.retired");
    expect(JSON.parse(String(history[0]!.payload)).reason).toBe(
      "Duplicado: ya lo cubre el criterio sucesor"
    );
  });

  it("rejects an unknown criterion reference", async () => {
    readyGroup();

    const result = await call("rf_ac_supersede", {
      projectId,
      criterion: "AC-G01-999",
      expectedVersion: 1,
      text: "Texto nuevo confirmado",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Acceptance criterion not found");
  });

  it("rejects a stale expectedVersion instead of overwriting", async () => {
    const group = readyGroup();
    const before = listAcceptanceCriteria(group.id, {}, db)[0]!;

    const result = await call("rf_ac_retire", {
      projectId,
      criterion: before.code,
      expectedVersion: before.version + 5,
      reason: "Motivo confirmado del retiro",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("changed since version");
    expect(listAcceptanceCriteria(group.id, {}, db)[0]!.status).toBe("active");
  });

  it("refuses to act twice on the same criterion", async () => {
    const group = readyGroup();
    const before = listAcceptanceCriteria(group.id, {}, db)[0]!;

    await call("rf_ac_retire", {
      projectId,
      criterion: before.code,
      expectedVersion: before.version,
      reason: "Motivo confirmado del retiro",
    });

    const second = await call("rf_ac_retire", {
      projectId,
      criterion: before.code,
      expectedVersion: before.version + 1,
      reason: "Segundo retiro sobre el mismo criterio",
    });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain("already 'retired'");
  });

  it("rejects a criterion owned by another project", async () => {
    const group = readyGroup();
    const before = listAcceptanceCriteria(group.id, {}, db)[0]!;
    const otherProject = createProject({ name: "Otra", mode: "product" }, db).id;

    const result = await call("rf_ac_supersede", {
      projectId: otherProject,
      criterion: before.code,
      expectedVersion: before.version,
      text: "Intento de editar desde otro proyecto",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Acceptance criterion not found");
  });

  it("keeps superseded and retired criteria out of the executable scope", async () => {
    const group = readyGroup(["Primer criterio", "Segundo criterio"]);
    const [first, second] = listAcceptanceCriteria(group.id, {}, db);

    await call("rf_ac_supersede", {
      projectId,
      criterion: first!.code,
      expectedVersion: first!.version,
      text: "Primer criterio corregido",
    });
    await call("rf_ac_retire", {
      projectId,
      criterion: second!.code,
      expectedVersion: second!.version,
      reason: "Ya no aplica a este incremento",
    });

    const view = getIncrementView(group.id, db);
    expect(view.acceptanceCriteria).toHaveLength(1);
    expect(view.acceptanceCriteria[0]!.text).toBe("Primer criterio corregido");

    const active = listAcceptanceCriteria(group.id, {}, db);
    const all = listAcceptanceCriteria(group.id, { includeInactive: true }, db);
    expect(active).toHaveLength(1);
    expect(all).toHaveLength(3);
    expect(all.map((entry) => entry.status).sort()).toEqual([
      "active",
      "retired",
      "superseded",
    ]);

    const drained = await call("rf_ac_retire", {
      projectId,
      criterion: active[0]!.code,
      expectedVersion: active[0]!.version,
      reason: "Sin criterios activos para probar la readiness",
    });
    expect(drained.isError).toBeFalsy();

    const readiness = incrementReadiness(group.id, db);
    expect(readiness.ready).toBe(false);
    expect(getIncrementView(group.id, db).acceptanceCriteria).toHaveLength(0);
  });

  it("changing an approved scope drifts it and never approves it", async () => {
    const approved = approvedGroup();
    const criterion = listAcceptanceCriteria(approved.id, {}, db)[0]!;
    expect(getIncrementView(approved.id, db).drifted).toBe(false);

    const result = await call("rf_ac_supersede", {
      projectId,
      criterion: criterion.code,
      expectedVersion: criterion.version,
      text: "Criterio corregido despues de aprobar",
    });
    expect(result.isError).toBeFalsy();

    const view = getIncrementView(approved.id, db);
    expect(view.drifted).toBe(true);
    expect(view.canExecute).toBe(false);
    expect(view.nextAction).toBe("request_approval");

    const stored = getIncrement(approved.id, db)!;
    expect(stored.approved_revision).toBe(1);
    expect(stored.status).toBe("aprobado");
    expect(stored.approved_by).toBe(HUMAN);
  });
});
