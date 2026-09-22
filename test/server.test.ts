import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { createHttpServer } from "../src/server/http.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("HTTP Server & REST API Layer", () => {
  let db: Database;
  let server: ReturnType<typeof createHttpServer>;
  let baseUrl: string;
  let tempUiDir: string;

  beforeAll(() => {
    db = createDatabase(":memory:");
    tempUiDir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-test-ui-"));
    fs.writeFileSync(path.join(tempUiDir, "index.html"), "<h1>RequireFlow UI</h1>");
    fs.writeFileSync(path.join(tempUiDir, "styles.css"), "body { margin: 0; }");

    server = createHttpServer({
      port: 0, // ephemeral port
      host: "127.0.0.1",
      db,
      uiDir: tempUiDir,
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop();
    db.close();
    fs.rmSync(tempUiDir, { recursive: true, force: true });
  });

  it("should serve static assets correctly", async () => {
    const resHtml = await fetch(`${baseUrl}/`);
    expect(resHtml.status).toBe(200);
    expect(resHtml.headers.get("content-type")).toContain("text/html");
    const htmlText = await resHtml.text();
    expect(htmlText).toBe("<h1>RequireFlow UI</h1>");

    const resCss = await fetch(`${baseUrl}/styles.css`);
    expect(resCss.status).toBe(200);
    expect(resCss.headers.get("content-type")).toContain("text/css");

    const res404 = await fetch(`${baseUrl}/non-existent.txt`);
    expect(res404.status).toBe(404);
  });

  it("should manage projects via REST API", async () => {
    // 1. Create project
    const postRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Web App API Test", description: "REST Testing" }),
    });
    expect(postRes.status).toBe(201);
    const created = await postRes.json();
    expect(created.id).toBeDefined();
    expect(created.name).toBe("Web App API Test");

    // 2. List projects
    const listRes = await fetch(`${baseUrl}/api/projects`);
    expect(listRes.status).toBe(200);
    const projects = await listRes.json();
    expect(projects.length).toBeGreaterThanOrEqual(1);

    // 3. Get single project
    const getRes = await fetch(`${baseUrl}/api/projects/${created.id}`);
    expect(getRes.status).toBe(200);
    const single = await getRes.json();
    expect(single.id).toBe(created.id);
  });

  it("should execute task lifecycle and archival via REST API", async () => {
    // Create a project
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Lifecycle Project" }),
    });
    const proj = await projRes.json();

    // Get default sections
    const secRes = await fetch(`${baseUrl}/api/projects/${proj.id}/sections`);
    const sections = await secRes.json();
    expect(sections.length).toBe(4);

    // Create a task
    const taskRes = await fetch(`${baseUrl}/api/projects/${proj.id}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test Task via API",
        type: "bugfix",
        priority: "high",
        sectionId: sections[0].id,
      }),
    });
    expect(taskRes.status).toBe(201);
    const task = await taskRes.json();
    expect(task.title).toBe("Test Task via API");

    // Kanban board
    const boardRes = await fetch(`${baseUrl}/api/projects/${proj.id}/board`);
    const board = await boardRes.json();
    expect(board.todo.length).toBe(1);
    expect(board.in_progress.length).toBe(0);

    // Start task
    const startRes = await fetch(`${baseUrl}/api/tasks/${task.id}/start`, { method: "POST" });
    expect(startRes.status).toBe(200);
    const started = await startRes.json();
    expect(started.status).toBe("in_progress");

    // Complete task
    const completeRes = await fetch(`${baseUrl}/api/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "Fixed and tested in dev" }),
    });
    expect(completeRes.status).toBe(200);
    const completed = await completeRes.json();
    expect(completed.status).toBe("done");

    // Archive done tasks
    const archiveRes = await fetch(`${baseUrl}/api/projects/${proj.id}/archive-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ forceManual: true }),
    });
    expect(archiveRes.status).toBe(200);
    const archiveData = await archiveRes.json();
    expect(archiveData.archivedCount).toBe(1);

    // History
    const historyRes = await fetch(`${baseUrl}/api/projects/${proj.id}/history`);
    expect(historyRes.status).toBe(200);
    const history = await historyRes.json();
    expect(history.total).toBe(1);
    expect(history.items[0].notes).toBe("Fixed and tested in dev");

    // Metrics
    const metricsRes = await fetch(`${baseUrl}/api/projects/${proj.id}/metrics`);
    expect(metricsRes.status).toBe(200);
    const metrics = await metricsRes.json();
    expect(metrics.totalCompleted).toBe(1);
  });
});
