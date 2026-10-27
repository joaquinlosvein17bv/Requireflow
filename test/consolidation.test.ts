import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { createProject, listProjects } from "../src/domain/project.ts";
import {
  createWorkItem,
  updateWorkItem,
  WorkItemValidationError,
  type WorkItem,
} from "../src/domain/backlog/work-item.ts";
import {
  listAcceptanceCriteria,
} from "../src/domain/backlog/criteria.ts";
import {
  approveIncrement,
  getIncrement,
  getIncrementView,
  incrementReadiness,
  listIncrementStories,
  listIncrements,
  proposeGroups,
  refineIncrement,
} from "../src/domain/backlog/increment.ts";
import {
  assertTaskCreationAllowed,
  taskEligibility,
} from "../src/domain/backlog/eligibility.ts";
import { createTask, listTasks } from "../src/domain/task.ts";
import {
  acceptIncrement,
  deliverCorrection,
  listFindings,
  listReviews,
  reportDefect,
  startImplementation,
  submitImplementationEvidence,
} from "../src/domain/backlog/review.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { createHttpServer } from "../src/server/http.ts";
import { parseJson } from "./helpers.ts";

const HUMAN = "human:test";
const AGENT = "agent:odd";

describe("Consolidation P01–P08", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function readyStory(projectId: string, epicId: string, title: string): WorkItem {
    let story = createWorkItem(
      {
        projectId,
        kind: "story",
        title,
        description: `${title}: comportamiento confirmado por el usuario.`,
        parentId: epicId,
      },
      db
    );
    story = updateWorkItem(story.id, story.version, { status: "refined" }, HUMAN, db);
    return updateWorkItem(story.id, story.version, { status: "ready" }, HUMAN, db);
  }

  function draftStory(projectId: string, epicId: string, title: string): WorkItem {
    return createWorkItem(
      {
        projectId,
        kind: "story",
        title,
        description: `${title}: capacidad expresada por el usuario, pendiente de detalle.`,
        parentId: epicId,
        status: "draft",
      },
      db
    );
  }

  function fourGroups() {
    const project = createProject({ name: "Cartas", mode: "product" }, db);
    const epic = createWorkItem({ projectId: project.id, kind: "epic", title: "Cartas" }, db);
    const opening = readyStory(project.id, epic.id, "Abrir el sobre con animación");
    const decoration = readyStory(project.id, epic.id, "Lluvia de decoraciones en la apertura");
    const carousel = draftStory(project.id, epic.id, "Carrusel opcional de fotografías");
    const claim = draftStory(project.id, epic.id, "Reclamar la carta y responder");
    const conversation = draftStory(project.id, epic.id, "Consultar conversaciones");

    const proposed = proposeGroups(
      project.id,
      [
        {
          code: "G01",
          name: "Crear, compartir y abrir una carta",
          goal: "Crear una carta, compartir su enlace y abrirla con animación y decoraciones.",
          storyIds: [opening.id, decoration.id],
          acceptanceCriteria: ["La carta se abre con una pulsación sostenida."],
        },
        {
          code: "G02",
          name: "Explorar fotografías",
          goal: "Explorar un carrusel opcional de fotografías.",
          storyIds: [carousel.id],
          dependsOn: ["G01"],
        },
        {
          code: "G03",
          name: "Reclamar y responder cartas",
          goal: "Reclamar la carta y responderla desde una cuenta.",
          storyIds: [claim.id],
          dependsOn: ["G01"],
        },
        {
          code: "G04",
          name: "Consultar conversaciones",
          goal: "Consultar el intercambio de cartas en conversaciones.",
          storyIds: [conversation.id],
          dependsOn: ["G03"],
        },
      ],
      "agent:po",
      db
    );

    return { project, epic, proposed };
  }

  // P01 — future groups are visible and cannot execute or be approved.
  it("persists G01–G04 and exposes them through domain, API and MCP", async () => {    const { project, proposed } = fourGroups();
    const groups = listIncrements(project.id, db);
    expect(groups).toHaveLength(4);
    expect(proposed.created.map((group) => group.code)).toEqual(["G01", "G02", "G03", "G04"]);

    const g02 = groups.find((group) => group.code === "G02")!;
    const view = getIncrementView(g02.id, db);
    expect(view.canExecute).toBe(false);
    expect(view.nextAction).toBe("refine");
    expect(incrementReadiness(g02.id, db).ready).toBe(false);
    expect(() =>
      approveIncrement(g02.id, { expectedVersion: g02.version, actor: HUMAN }, db)
    ).toThrow(/cannot be approved/);

    const server = createHttpServer({ port: 0, host: "127.0.0.1", db });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/projects/${project.id}/groups`);
      expect(res.status).toBe(200);
      const apiGroups = parseJson<unknown[]>(await res.text());
      expect(apiGroups).toHaveLength(4);
    } finally {
      server.stop();
    }

    const mcp = createMcpServer(db) as any;
    const mcpGroups = parseJson<unknown[]>(
      (await mcp._registeredTools["rf_group_list"].handler({ projectId: project.id })).content[0].text
    );
    expect(mcpGroups).toHaveLength(4);

    // The dashboard reads the same endpoint and ships the groups view.
    const dashboard = createHttpServer({ port: 0, host: "127.0.0.1", db });
    try {
      const html = await (await fetch(`http://127.0.0.1:${dashboard.port}/`)).text();
      expect(html).toContain('data-tab="groups"');
      expect(html).toContain('id="groupsList"');
    } finally {
      dashboard.stop();
    }
  });

  // P01b — implicit MCP resolution never creates a phantom project.
  it("does not create a phantom project when an MCP tool omits projectId", async () => {
    const mcp = createMcpServer(db) as any;
    const res = await mcp._registeredTools["rf_task_list"].handler({});

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No project is registered");
    expect(listProjects(db)).toHaveLength(0);
  });

  // P02 — progressive registration: confirmed stories persist while others stay draft.
  it("registers confirmed stories progressively and keeps G01 refining", () => {
    const project = createProject({ name: "Cartas", mode: "product" }, db);
    const epic = createWorkItem({ projectId: project.id, kind: "epic", title: "Cartas" }, db);
    const h001 = readyStory(project.id, epic.id, "Generar y compartir un enlace único");
    const h002 = readyStory(project.id, epic.id, "Apertura animada del sobre");
    const h003 = draftStory(project.id, epic.id, "Pregunta de acceso pendiente de decisión");

    const proposed = proposeGroups(
      project.id,
      [
        {
          code: "G01",
          goal: "Crear, compartir y abrir una carta.",
          storyIds: [h001.id, h002.id, h003.id],
          acceptanceCriteria: ["La carta se abre con una pulsación sostenida."],
        },
      ],
      "agent:po",
      db
    );
    const g01 = proposed.created[0]!;

    expect(listIncrementStories(g01.id, db)).toHaveLength(3);
    expect(listIncrements(project.id, db)[0]!.status).toBe("planificado");
    expect(incrementReadiness(g01.id, db).ready).toBe(false);
    expect(incrementReadiness(g01.id, db).blockers.join(" ")).toContain("H003");
  });

  // P03 — no invented or placeholder requirements.
  it("rejects placeholder requirements and keeps the backlog unchanged", () => {
    const project = createProject({ name: "Cartas", mode: "product" }, db);
    const epic = createWorkItem({ projectId: project.id, kind: "epic", title: "Cartas" }, db);

    expect(() =>
      createWorkItem(
        {
          projectId: project.id,
          kind: "story",
          title: "Historia ambigua",
          description: "TODO",
          parentId: epic.id,
        },
        db
      )
    ).toThrow(WorkItemValidationError);

    expect(() =>
      proposeGroups(project.id, [{ code: "G01", goal: "por definir" }], "agent:po", db)
    ).toThrow(/unspecified marker|por definir/i);

    expect(listIncrements(project.id, db)).toHaveLength(0);
  });

  // P04 — grouping fidelity: animation and decorations stay in G01.
  it("keeps the opening animation and decorations in G01 and preserves dependencies", () => {
    const { proposed } = fourGroups();
    const g01 = proposed.created.find((group) => group.code === "G01")!;
    const g03 = proposed.created.find((group) => group.code === "G03")!;
    const g04 = proposed.created.find((group) => group.code === "G04")!;

    const titles = listIncrementStories(g01.id, db).map((story) => story.title);
    expect(titles).toContain("Abrir el sobre con animación");
    expect(titles).toContain("Lluvia de decoraciones en la apertura");

    const dependencies = db
      .query(
        `SELECT i.code FROM increment_dependencies d
           JOIN increments i ON i.id = d.depends_on_increment_id
          WHERE d.increment_id = ? ORDER BY i.code`
      )
      .all(g03.id) as Array<{ code: string }>;
    expect(dependencies.map((row) => row.code)).toEqual(["G01"]);

    const g04Deps = db
      .query(
        `SELECT i.code FROM increment_dependencies d
           JOIN increments i ON i.id = d.depends_on_increment_id
          WHERE d.increment_id = ? ORDER BY i.code`
      )
      .all(g04.id) as Array<{ code: string }>;
    expect(g04Deps.map((row) => row.code)).toEqual(["G03"]);
  });

  // P06 — technical execution is allowed only inside an approved group.
  it("rejects tasks without a story or with an unapproved group and accepts approved ones", () => {
    const project = createProject({ name: "Cartas", mode: "product" }, db);
    const epic = createWorkItem({ projectId: project.id, kind: "epic", title: "Cartas" }, db);
    const story = readyStory(project.id, epic.id, "Abrir el sobre");

    expect(() => assertTaskCreationAllowed(project, null, db)).toThrow(/must belong to a story/);
    expect(() => assertTaskCreationAllowed(project, story.id, db)).toThrow(
      /does not belong to any group/
    );
    expect(() => createTask({ projectId: project.id, title: "Implementar" }, db)).toThrow();

    const proposed = proposeGroups(
      project.id,
      [
        {
          code: "G01",
          goal: "Abrir la carta.",
          storyIds: [story.id],
          acceptanceCriteria: ["La carta se abre."],
        },
      ],
      "agent:po",
      db
    );
    expect(() => assertTaskCreationAllowed(project, story.id, db)).toThrow(/not approved/);
    let g01 = proposed.created[0]!;
    g01 = refineIncrement(
      g01.id,
      g01.version,
      { status: "en_refinamiento" },
      HUMAN,
      db
    );
    g01 = refineIncrement(
      g01.id,
      g01.version,
      { status: "listo_para_aprobacion" },
      HUMAN,
      db
    );
    g01 = approveIncrement(g01.id, { expectedVersion: g01.version, actor: HUMAN }, db);

    expect(taskEligibility(
      createTask({ projectId: project.id, title: "Implementar apertura", workItemId: story.id }, db),
      project,
      db
    ).eligible).toBe(true);

    const legacy = createProject({ name: "Legacy", mode: "legacy" }, db);
    expect(() => assertTaskCreationAllowed(legacy, null, db)).not.toThrow();
    expect(createTask({ projectId: legacy.id, title: "Tarea legacy" }, db).id).toBeTruthy();
  });

  // P07 — rf_group_get is the handoff: it contains the whole scope.
  it("returns the complete group view through rf_group_get", async () => {
    const { project, proposed } = fourGroups();
    const g01 = proposed.created.find((group) => group.code === "G01")!;
    const mcp = createMcpServer(db) as any;
    const view = parseJson<Record<string, any>>(
      (
        await mcp._registeredTools["rf_group_get"].handler({
          projectId: project.id,
          group: "G01",
        })
      ).content[0].text
    );

    for (const key of [
      "increment",
      "stories",
      "acceptanceCriteria",
      "decisions",
      "dependencies",
      "readiness",
      "canExecute",
      "nextAction",
    ]) {
      expect(view[key]).toBeDefined();
    }
    expect(view.increment.id).toBe(g01.id);
    expect(view.stories).toHaveLength(2);
    expect(view.nextAction).toBe("refine");
  });

  // P08 — review and correction cycles survive; no automatic acceptance; G02 is not executed.
  it("preserves defects and criteria across correction cycles without accepting automatically", () => {
    const project = createProject({ name: "Cartas", mode: "product" }, db);
    const epic = createWorkItem({ projectId: project.id, kind: "epic", title: "Cartas" }, db);
    const story = readyStory(project.id, epic.id, "Abrir el sobre");

    const proposed = proposeGroups(
      project.id,
      [
        {
          code: "G01",
          goal: "Abrir la carta.",
          storyIds: [story.id],
          acceptanceCriteria: ["La carta se abre."],
        },
        { code: "G02", name: "Carrusel", goal: "Explorar fotografías.", dependsOn: ["G01"] },
      ],
      "agent:po",
      db
    );
    let g01 = proposed.created.find((group) => group.code === "G01")!;
    const g02 = proposed.created.find((group) => group.code === "G02")!;

    g01 = refineIncrement(g01.id, g01.version, { status: "en_refinamiento" }, HUMAN, db);
    g01 = refineIncrement(g01.id, g01.version, { status: "listo_para_aprobacion" }, HUMAN, db);
    g01 = approveIncrement(g01.id, { expectedVersion: g01.version, actor: HUMAN }, db);
    g01 = startImplementation(g01.id, AGENT, db);

    submitImplementationEvidence(
      { incrementId: g01.id, actor: AGENT, evidence: "Tests verdes." },
      db
    );
    expect(getIncrement(g01.id, db)!.status).toBe("pendiente_revision_humana");

    reportDefect(
      {
        incrementId: g01.id,
        actor: HUMAN,
        description: "El sobre no se abre al mantener presionado.",
        acceptanceCriterionCode: "AC-G01-001",
      },
      db
    );
    expect(getIncrement(g01.id, db)!.status).toBe("en_correcciones");
    expect(listFindings(listReviews(g01.id, db)[0]!.id, db)).toHaveLength(1);

    deliverCorrection(
      { incrementId: g01.id, actor: AGENT, evidence: "Corrección entregada." },
      db
    );
    expect(getIncrement(g01.id, db)!.status).toBe("pendiente_revision_humana");
    expect(listReviews(g01.id, db)).toHaveLength(2);
    expect(listAcceptanceCriteria(g01.id, {}, db)).toHaveLength(1);

    // An agent cannot accept; the human channel can.
    const current = getIncrement(g01.id, db)!;
    expect(() =>
      acceptIncrement(
        { incrementId: g01.id, actor: AGENT, expectedVersion: current.version },
        db
      )
    ).toThrow(/human-driven/);

    acceptIncrement(
      { incrementId: g01.id, actor: HUMAN, expectedVersion: current.version, evidence: "Probado." },
      db
    );
    expect(getIncrement(g01.id, db)!.status).toBe("aceptado");
    expect(listFindings(listReviews(g01.id, db)[0]!.id, db)[0]!.status).toBe("resolved");

    // Accepting G01 does not execute G02.
    expect(getIncrement(g02.id, db)!.status).toBe("planificado");
    expect(getIncrementView(g02.id, db).canExecute).toBe(false);
    expect(listTasks(project.id, {}, db)).toHaveLength(0);
  });
});
