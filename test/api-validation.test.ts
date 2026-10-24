import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { createHttpServer } from "../src/server/http.ts";
import type { Project } from "../src/domain/project.ts";
import { readJson } from "./helpers.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("HTTP validation and error handling (RF-20)", () => {
  let db: Database;
  let server: ReturnType<typeof createHttpServer>;
  let baseUrl: string;
  let token: string;
  const tokenHeader = "x-requireflow-token";

  beforeAll(() => {
    db = createDatabase(":memory:");
    token = "test-token";
    server = createHttpServer({
      port: 0,
      host: "127.0.0.1",
      db,
      token,
      uiDir: fs.mkdtempSync(path.join(os.tmpdir(), "rf-validation-ui-")),
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop();
    db.close();
  });

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return { "Content-Type": "application/json", [tokenHeader]: token, ...extra };
  }

  async function createProject(name = "validation"): Promise<Project> {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name }),
    });
    return readJson<Project>(res);
  }

  it("rejects malformed JSON with 400", async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: headers(),
      body: "{ this is not json",
    });

    expect(res.status).toBe(400);
    const body = await readJson<{ error: string }>(res);
    expect(body.error.toLowerCase()).toContain("json");
  });

  it("rejects a missing project name with 400 and names the field", async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ description: "no name" }),
    });

    expect(res.status).toBe(400);
    expect((await readJson<{ error: string }>(res)).error).toContain("name");
  });

  it("rejects an over-long project name with 400", async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "x".repeat(500) }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unsupported enum value with 422", async () => {
    const project = await createProject();

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/tasks`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "bad status", status: "imaginary" }),
    });

    expect(res.status).toBe(422);
    const body = await readJson<{ error: string }>(res);
    expect(body.error).toContain("imaginary");
    expect(body.error).not.toContain("CHECK constraint");
  });

  it("rejects an unsupported priority on update with 422", async () => {
    const project = await createProject();
    const created = await fetch(`${baseUrl}/api/projects/${project.id}/tasks`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "valid" }),
    });
    const task = await readJson<{ id: string }>(created);

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ priority: "asap" }),
    });

    expect(res.status).toBe(422);
    expect((await readJson<{ error: string }>(res)).error).toContain("asap");
  });

  it("rejects a missing title with 400", async () => {
    const project = await createProject();
    const res = await fetch(`${baseUrl}/api/projects/${project.id}/tasks`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ priority: "high" }),
    });

    expect(res.status).toBe(400);
    expect((await readJson<{ error: string }>(res)).error).toContain("title");
  });

  it("rejects invalid pagination and window parameters with 400", async () => {
    const project = await createProject();

    const badLimit = await fetch(`${baseUrl}/api/projects/${project.id}/history?limit=abc`);
    expect(badLimit.status).toBe(400);

    const hugeLimit = await fetch(`${baseUrl}/api/projects/${project.id}/history?limit=10000`);
    expect(hugeLimit.status).toBe(400);

    const badPage = await fetch(`${baseUrl}/api/projects/${project.id}/history?page=0`);
    expect(badPage.status).toBe(400);

    const badDays = await fetch(`${baseUrl}/api/projects/${project.id}/metrics?days=0`);
    expect(badDays.status).toBe(400);

    const nanDays = await fetch(`${baseUrl}/api/projects/${project.id}/metrics?days=abc`);
    expect(nanDays.status).toBe(400);
  });

  it("accepts a bounded pagination request", async () => {
    const project = await createProject();
    const res = await fetch(
      `${baseUrl}/api/projects/${project.id}/history?page=1&limit=50`
    );
    expect(res.status).toBe(200);
  });

  it("returns 404 for an unknown task instead of a server error", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/does-not-exist`, { headers: headers() });
    expect(res.status).toBe(404);
  });

  it("never leaks SQLite details on an unexpected failure", async () => {
    // A closed database is a genuine unexpected failure: the client must get a
    // generic message while the technical detail stays in the server log.
    const brokenDb = createDatabase(":memory:");
    const brokenServer = createHttpServer({
      port: 0,
      host: "127.0.0.1",
      db: brokenDb,
      token,
      uiDir: fs.mkdtempSync(path.join(os.tmpdir(), "rf-broken-ui-")),
    });
    brokenDb.close();

    try {
      const res = await fetch(`http://127.0.0.1:${brokenServer.port}/api/projects`, {
        headers: headers(),
      });

      expect(res.status).toBe(500);
      const body = await readJson<{ error: string }>(res);
      expect(body.error).toBe("Internal server error");
      expect(body.error.toLowerCase()).not.toContain("sqlite");
      expect(body.error.toLowerCase()).not.toContain("closed");
    } finally {
      brokenServer.stop();
    }
  });

  it("validates section colours", async () => {
    const project = await createProject();
    const res = await fetch(`${baseUrl}/api/projects/${project.id}/sections`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "Malicious", color: 'red;" onmouseover="alert(1)' }),
    });

    expect(res.status).toBe(400);
  });
});
