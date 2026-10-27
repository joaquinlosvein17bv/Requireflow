import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../src/db/connection.ts";
import { createHttpServer } from "../src/server/http.ts";

/**
 * End-to-end product backlog scenario over the real HTTP contracts.
 *
 * ODD's technical work is simulated: evidence and corrections are submitted
 * through the same endpoints the agent would use. Nothing here pretends that a
 * card game was built.
 */
describe("E2E: idea -> groups -> approval -> ODD evidence -> defect -> acceptance", () => {
  let db: Database;
  let server: ReturnType<typeof createHttpServer>;
  let baseUrl: string;
  let projectId: string;
  const token = "e2e-token";
  const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-e2e-ui-"));

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-requireflow-token": token,
      "x-requireflow-actor": "user:test",
      ...extra,
    };
  }

  async function api(
    pathname: string,
    method: string,
    body?: unknown
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? null : JSON.parse(text) };
  }

  async function story(epicId: string, title: string): Promise<any> {
    const created = await api(`/api/projects/${projectId}/work-items`, "POST", {
      kind: "story",
      title,
      description: `${title}: comportamiento confirmado por el usuario`,
      parentId: epicId,
    });
    expect(created.status).toBe(201);

    const refined = await api(`/api/backlog/items/${created.body.id}`, "PATCH", {
      expectedVersion: created.body.version,
      status: "refined",
    });
    expect(refined.status).toBe(200);

    const ready = await api(`/api/backlog/items/${created.body.id}`, "PATCH", {
      expectedVersion: refined.body.version,
      status: "ready",
    });
    expect(ready.status).toBe(200);
    return ready.body;
  }

  beforeAll(async () => {
    db = createDatabase(":memory:");
    server = createHttpServer({ port: 0, host: "127.0.0.1", db, token, uiDir });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop();
    db.close();
    fs.rmSync(uiDir, { recursive: true, force: true });
  });

  it("runs the whole product cycle with human gates", async () => {
    // 1. New product project
    const project = await api("/api/projects", "POST", {
      name: "Cartas Digitales",
      mode: "product",
      rootPath: path.join(uiDir, "cartas"),
    });
    expect(project.status).toBe(201);
    expect(project.body.mode).toBe("product");
    projectId = project.body.id;

    // 2. Fast capture: literal words, no questions, no task
    const idea = await api(`/api/projects/${projectId}/ideas`, "POST", {
      text: "Quiero un juego de cartas para mandar mensajes y reclamar cartas",
    });
    expect(idea.status).toBe(201);
    expect(idea.body.item.kind).toBe("idea");
    const tasksAfterIdea = db
      .query("SELECT COUNT(*) c FROM tasks WHERE project_id = ?")
      .get(projectId) as { c: number };
    expect(Number(tasksAfterIdea.c)).toBe(0);

    // 3. Refinement: epics and stories with confirmed text
    const epics: Record<string, string> = {};
    for (const name of ["Crear cartas", "Acceso", "Conversaciones"]) {
      const epic = await api(`/api/projects/${projectId}/work-items`, "POST", {
        kind: "epic",
        title: name,
      });
      expect(epic.status).toBe(201);
      epics[name] = epic.body.id;
    }

    const createStory = await story(epics["Crear cartas"]!, "Crear una carta con imagen");
    const shareStory = await story(epics["Acceso"]!, "Compartir una carta por link");
    const openStory = await story(epics["Acceso"]!, "Abrir una carta recibida");
    const claimStory = await story(epics["Conversaciones"]!, "Reclamar una carta");
    const viewStory = await story(epics["Conversaciones"]!, "Ver la conversación");

    // 4. Automatic grouping proposal: cross-epic, all groups at once
    const proposal = await api(`/api/projects/${projectId}/groups`, "POST", {
      groups: [
        {
          code: "G01",
          name: "Crear, compartir y abrir",
          goal: "El usuario crea una carta, la comparte y otro la abre",
          storyIds: [createStory.id, shareStory.id, openStory.id],
          acceptanceCriteria: [
            "La carta creada se comparte por link",
            "El receptor abre la carta con la imagen visible",
          ],
        },
        {
          code: "G02",
          name: "Reclamar y responder",
          goal: "El receptor reclama la carta y responde",
          storyIds: [claimStory.id],
          acceptanceCriteria: ["El receptor puede reclamar una carta abierta"],
          dependsOn: ["G01"],
        },
        {
          code: "G03",
          name: "Conversaciones",
          goal: "Los participantes ven el historial",
          storyIds: [viewStory.id],
          acceptanceCriteria: ["La conversación muestra los mensajes en orden"],
          dependsOn: ["G02"],
        },
      ],
    });
    expect(proposal.status).toBe(201);
    expect(proposal.body.created.map((group: any) => group.code)).toEqual(["G01", "G02", "G03"]);

    // 5. Three groups visible, future ones provisional
    const groups = await api(`/api/projects/${projectId}/groups`, "GET");
    expect(groups.body).toHaveLength(3);
    expect(groups.body.map((view: any) => view.increment.status)).toEqual([
      "planificado",
      "planificado",
      "planificado",
    ]);
    expect(groups.body[0].stories).toHaveLength(3);

    // 6. Refine G01 only
    const g01 = groups.body.find((view: any) => view.increment.code === "G01");
    const refine = await api(`/api/groups/${g01.increment.id}`, "PATCH", {
      expectedVersion: g01.increment.version,
      status: undefined,
    });
    expect(refine.status).toBe(200);

    // Moving to "ready for approval" happens through the group status patch.
    let current = refine.body;
    for (const status of ["en_refinamiento", "listo_para_aprobacion"]) {
      const moved = await api(`/api/groups/${current.id}`, "PATCH", {
        expectedVersion: current.version,
        status,
      });
      expect(moved.status).toBe(200);
      current = { ...moved.body, id: moved.body.id };
    }
    // PATCH returns the increment row; reload the view for the version.
    const g01View = (await api(`/api/groups/${g01.increment.id}`, "GET")).body;
    expect(g01View.increment.status).toBe("listo_para_aprobacion");
    expect(g01View.readiness.ready).toBe(true);

    // 7. Human scope approval with the exact confirmation phrase
    const approved = await api(`/api/groups/${g01.increment.id}/approve`, "POST", {
      expectedVersion: g01View.increment.version,
      confirm: "APROBAR G01",
    });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("aprobado");
    expect(approved.body.approved_revision).toBe(1);

    // 8. The agent reads the approved group directly
    const readable = (await api(`/api/groups/${g01.increment.id}`, "GET")).body;
    expect(readable.canExecute).toBe(true);
    expect(readable.readiness.ready).toBe(true);
    expect(readable.acceptanceCriteria).toHaveLength(2);
    expect(readable.increment.approved_by).toBe("human:ui");

    // 9. G02 cannot start without authorization
    const g02 = groups.body.find((view: any) => view.increment.code === "G02");
    const blockedStart = await api(`/api/groups/${g02.increment.id}/start`, "POST", {});
    expect(blockedStart.status).toBe(422);

    // Server-side task gate: unlinked and unapproved work is refused
    const unlinked = await api(`/api/projects/${projectId}/tasks`, "POST", {
      title: "Tarea sin historia",
    });
    expect(unlinked.status).toBe(422);
    const earlyTask = await api(`/api/projects/${projectId}/tasks`, "POST", {
      title: "Implementar G02 antes de tiempo",
      workItemId: claimStory.id,
    });
    expect(earlyTask.status).toBe(422);

    // 10. ODD starts G01 and reports evidence through the real contract
    const started = await api(`/api/groups/${g01.increment.id}/start`, "POST", {});
    expect(started.status).toBe(200);
    expect(started.body.status).toBe("en_implementacion");

    const evidence = await api(`/api/groups/${g01.increment.id}/evidence`, "POST", {
      evidence: "SIMULADO: 42 tests, build ok, criterios comprobados a mano",
    });
    expect(evidence.status).toBe(200);
    expect(evidence.body.status).toBe("pending");

    // 11. Technical completion is not acceptance
    const waiting = (await api(`/api/groups/${g01.increment.id}`, "GET")).body;
    expect(waiting.increment.status).toBe("pendiente_revision_humana");
    expect(waiting.nextAction).toBe("await_review");

    // 12. The user reports a defect against a criterion
    const criterion = waiting.acceptanceCriteria[0];
    const defect = await api(`/api/groups/${g01.increment.id}/defects`, "POST", {
      description: "Al abrir la carta el link no muestra la imagen",
      acceptanceCriterionCode: criterion.code,
    });
    expect(defect.status).toBe(200);
    expect((await api(`/api/groups/${g01.increment.id}`, "GET")).body.increment.status).toBe(
      "en_correcciones"
    );

    // 13. ODD delivers the correction and the group returns to review
    const correction = await api(`/api/groups/${g01.increment.id}/corrections`, "POST", {
      evidence: "SIMULADO: la imagen ahora viaja con el link",
    });
    expect(correction.status).toBe(200);
    expect(correction.body.cycle).toBe(2);

    // 14. Human acceptance
    const beforeAccept = (await api(`/api/groups/${g01.increment.id}`, "GET")).body;
    const accepted = await api(`/api/groups/${g01.increment.id}/accept`, "POST", {
      expectedVersion: beforeAccept.increment.version,
      confirm: "ACEPTAR G01",
      evidence: "Probado por el usuario en el navegador",
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe("aceptado");

    const finalView = (await api(`/api/groups/${g01.increment.id}`, "GET")).body;
    expect(finalView.reviews.at(-1).status).toBe("accepted");
    expect(finalView.reviews[0].findings[0].status).toBe("resolved");

    // 15. G02 is next, and is not executed automatically
    const next = await api(`/api/projects/${projectId}/groups/next`, "GET");
    expect(next.body.group.increment.code).toBe("G02");
    expect(next.body.group.canExecute).toBe(false);
    expect(next.body.group.increment.status).not.toBe("en_implementacion");
  });

  it("rejects an approval with the wrong confirmation phrase", async () => {
    const groups = await api(`/api/projects/${projectId}/groups`, "GET");
    const g02 = groups.body.find((view: any) => view.increment.code === "G02");

    const attempt = await api(`/api/groups/${g02.increment.id}/approve`, "POST", {
      expectedVersion: g02.increment.version,
      confirm: "APROBAR G03",
    });
    expect(attempt.status).toBe(422);
    expect((await api(`/api/groups/${g02.increment.id}`, "GET")).body.increment.status).toBe(
      "planificado"
    );
  });

  it("refuses to approve a group whose stories are not refined", async () => {
    const epic = await api(`/api/projects/${projectId}/work-items`, "POST", {
      kind: "epic",
      title: "Administración",
    });
    const draft = await api(`/api/projects/${projectId}/work-items`, "POST", {
      kind: "story",
      title: "Panel de administración",
      description: "Pendiente de confirmar alcance",
      parentId: epic.body.id,
    });
    const proposal = await api(`/api/projects/${projectId}/groups`, "POST", {
      groups: [
        {
          code: "G04",
          goal: "Administrar cartas",
          storyIds: [draft.body.id],
          acceptanceCriteria: ["El panel lista las cartas"],
        },
      ],
    });
    const groupId = proposal.body.created[0].id;

    const view = (await api(`/api/groups/${groupId}`, "GET")).body;
    expect(view.readiness.ready).toBe(false);

    let current = view.increment;
    for (const status of ["en_refinamiento", "listo_para_aprobacion"]) {
      const moved = await api(`/api/groups/${groupId}`, "PATCH", {
        expectedVersion: current.version,
        status,
      });
      current = moved.body;
    }

    const attempt = await api(`/api/groups/${groupId}/approve`, "POST", {
      expectedVersion: current.version,
      confirm: "APROBAR G04",
    });
    expect(attempt.status).toBe(422);
    expect(attempt.body.error).toContain("not ready");
  });

  it("refuses a placeholder decision and a stale version", async () => {
    const groups = await api(`/api/projects/${projectId}/groups`, "GET");
    const g01 = groups.body.find((view: any) => view.increment.code === "G01");

    const placeholder = await api(`/api/groups/${g01.increment.id}/decisions`, "POST", {
      title: "Imagen de portada",
      question: "¿Se elige de un set o se sube?",
      answer: "[NO ESPECIFICADO]",
    });
    expect(placeholder.status).toBe(422);

    const conflict = await api(`/api/backlog/items/${g01.stories[0].id}`, "PATCH", {
      expectedVersion: 1,
      title: "Otro título",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.current.version).toBeGreaterThan(1);
  });
});
