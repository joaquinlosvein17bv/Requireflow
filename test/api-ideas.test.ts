import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../src/db/connection.ts";
import { createHttpServer } from "../src/server/http.ts";

describe("Product backlog API", () => {
  let db: Database;
  let server: ReturnType<typeof createHttpServer>;
  let baseUrl: string;
  let projectId: string;
  const token = "test-token";
  const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-ideas-ui-"));

  function headers(): Record<string, string> {
    return { "content-type": "application/json", "x-requireflow-token": token };
  }

  async function api(pathname: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${pathname}`, init);
  }

  beforeAll(async () => {
    db = createDatabase(":memory:");
    server = createHttpServer({ port: 0, host: "127.0.0.1", db, token, uiDir });
    baseUrl = `http://127.0.0.1:${server.port}`;

    const created = await api("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "Card game", rootPath: path.join(uiDir, "card-game") }),
    });
    projectId = ((await created.json()) as { id: string }).id;
  });

  afterAll(() => {
    server.stop();
    db.close();
    fs.rmSync(uiDir, { recursive: true, force: true });
  });

  it("captures an idea without creating an executable task", async () => {
    const response = await api(`/api/projects/${projectId}/ideas`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ text: "Permitir compartir una carta por link" }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    expect(body.item.kind).toBe("idea");
    expect(body.item.status).toBe("captured");
    expect(body.duplicate_of).toBeNull();

    const tasks = db
      .query("SELECT COUNT(*) c FROM tasks WHERE project_id = ?")
      .get(projectId) as { c: number };
    expect(Number(tasks.c)).toBe(0);
  });

  it("returns 200 and the same idea when the operation key repeats", async () => {
    const payload = { text: "Carrusel de cartas", operationKey: "api-dup-1" };

    const first = await api(`/api/projects/${projectId}/ideas`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
    });
    const firstBody = (await first.json()) as any;

    const second = await api(`/api/projects/${projectId}/ideas`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
    });
    const secondBody = (await second.json()) as any;

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(secondBody.deduplicated).toBe(true);
    expect(secondBody.item.id).toBe(firstBody.item.id);
  });

  it("exposes the planning tree with ideas and no stories", async () => {
    const response = await api(`/api/projects/${projectId}/planning`);
    const tree = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(tree.ideas.length).toBeGreaterThanOrEqual(2);
    expect(tree.epics).toEqual([]);
    expect(tree.stories).toEqual([]);
  });

  it("rejects an empty idea text", async () => {
    const response = await api(`/api/projects/${projectId}/ideas`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ text: "   " }),
    });

    expect(response.status).toBe(400);
  });

  it("requires the mutation token", async () => {
    const response = await api(`/api/projects/${projectId}/ideas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "sin token" }),
    });

    expect(response.status).toBe(403);
  });

  it("returns 409 with the current state when expectedVersion is stale", async () => {
    const created = await api(`/api/projects/${projectId}/ideas`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ text: "Reclamar carta" }),
    });
    const item = ((await created.json()) as any).item;

    const moved = await api(`/api/backlog/items/${item.id}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ expectedVersion: 1, status: "draft" }),
    });
    expect(moved.status).toBe(200);

    const stale = await api(`/api/backlog/items/${item.id}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ expectedVersion: 1, status: "refined" }),
    });

    expect(stale.status).toBe(409);
    const body = (await stale.json()) as any;
    expect(body.current.version).toBe(2);
  });

  it("switches the project mode and rejects unsupported values", async () => {
    const invalid = await api(`/api/projects/${projectId}/mode`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ mode: "experimental" }),
    });
    expect(invalid.status).toBe(422);

    const valid = await api(`/api/projects/${projectId}/mode`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ mode: "product" }),
    });
    expect(valid.status).toBe(200);
    expect(((await valid.json()) as any).mode).toBe("product");
  });

  it("classifies a workspace without creating a project", async () => {
    const before = db.query("SELECT COUNT(*) c FROM projects").get() as { c: number };

    const response = await api("/api/workspace/classify?cwd=" + encodeURIComponent(uiDir));
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect([
      "project-linked",
      "project-subfolder",
      "nested-independent-repo",
      "empty-new",
      "existing-unregistered",
      "ambiguous",
    ]).toContain(body.situation);

    const after = db.query("SELECT COUNT(*) c FROM projects").get() as { c: number };
    expect(Number(after.c)).toBe(Number(before.c));
  });

  it("records the mode change in the change log", async () => {
    const response = await api(`/api/projects/${projectId}/changes`);
    const changes = (await response.json()) as any[];

    expect(changes.some((entry) => entry.action === "project.mode_changed")).toBe(true);
  });
});
