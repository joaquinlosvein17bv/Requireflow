import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { createHttpServer } from "../src/server/http.ts";
import type { Project } from "../src/domain/project.ts";
import { readJson } from "./helpers.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("Project detection is read-only over HTTP (RF-14)", () => {
  let db: Database;
  let server: ReturnType<typeof createHttpServer>;
  let baseUrl: string;
  const tempDirs: string[] = [];

  beforeAll(() => {
    db = createDatabase(":memory:");
    server = createHttpServer({
      port: 0,
      host: "127.0.0.1",
      db,
      uiDir: fs.mkdtempSync(path.join(os.tmpdir(), "rf-detection-ui-")),
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop();
    db.close();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function projectCount(): number {
    const row = db.query("SELECT COUNT(*) as c FROM projects").get() as { c: number };
    return Number(row.c);
  }

  function freshDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-detected-"));
    tempDirs.push(dir);
    return dir;
  }

  it("returns 404 for an unlinked directory without creating a project", async () => {
    const dir = freshDir();
    const before = projectCount();

    const res = await fetch(`${baseUrl}/api/projects/current?cwd=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(404);

    const body = await readJson<{ error: string; detected_root: string; suggested_name: string }>(
      res
    );
    expect(body.detected_root.length).toBeGreaterThan(0);
    expect(body.suggested_name.length).toBeGreaterThan(0);
    expect(projectCount()).toBe(before);
  });

  it("finds the project once it is registered, still without writing", async () => {
    const dir = freshDir();
    const created = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "detected-project", rootPath: dir }),
    });
    const project = await readJson<Project>(created);
    const before = projectCount();

    const res = await fetch(`${baseUrl}/api/projects/current?cwd=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(200);
    const detected = await readJson<Project & { is_directory_linked: boolean }>(res);
    expect(detected.id).toBe(project.id);
    expect(detected.is_directory_linked).toBe(true);
    expect(projectCount()).toBe(before);
  });

  it("resolves a subdirectory to the registered project", async () => {
    const dir = freshDir();
    const nested = path.join(dir, "src", "domain");
    fs.mkdirSync(nested, { recursive: true });

    const created = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nested-project", rootPath: dir }),
    });
    const project = await readJson<Project>(created);

    const res = await fetch(`${baseUrl}/api/projects/current?cwd=${encodeURIComponent(nested)}`);
    expect(res.status).toBe(200);
    const detected = await readJson<Project>(res);
    expect(detected.id).toBe(project.id);
  });

  it("rejects an invalid cwd instead of guessing", async () => {
    const before = projectCount();

    const missing = await fetch(
      `${baseUrl}/api/projects/current?cwd=${encodeURIComponent(path.join(os.tmpdir(), "rf-does-not-exist-xyz"))}`
    );
    expect(missing.status).toBe(400);

    const tooLong = await fetch(`${baseUrl}/api/projects/current?cwd=${"a".repeat(5000)}`);
    expect(tooLong.status).toBe(400);

    expect(projectCount()).toBe(before);
  });

  it("does not create a project for the server's own directory", async () => {
    const before = projectCount();
    const res = await fetch(`${baseUrl}/api/projects/current`);
    expect([200, 404]).toContain(res.status);
    expect(projectCount()).toBe(before);
  });
});
