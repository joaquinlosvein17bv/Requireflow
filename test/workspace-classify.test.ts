import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../src/db/connection.ts";
import { createProject, classifyWorkspace } from "../src/domain/project.ts";

/**
 * The five situations the product owner must tell apart. Confusing "not
 * registered" with "empty" creates phantom projects; confusing a nested
 * checkout with its umbrella project steals another repository's backlog.
 */
describe("Workspace classification", () => {
  let db: Database;
  const created: string[] = [];

  function tempDir(prefix = "rf-ws-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    created.push(dir);
    return dir;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
    for (const dir of created.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects an empty directory as initialisable", () => {
    const dir = tempDir();
    const result = classifyWorkspace(dir, db);

    expect(result.situation).toBe("empty-new");
    expect(result.canInitialize).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
  });

  it("detects an unregistered directory with files without offering to create a project", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "package.json"), "{}");

    const result = classifyWorkspace(dir, db);

    expect(result.situation).toBe("existing-unregistered");
    expect(result.canInitialize).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.project).toBeNull();
  });

  it("detects a freshly initialised git repository as existing, not empty", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, ".git"));

    const result = classifyWorkspace(dir, db);

    expect(result.situation).toBe("existing-unregistered");
    expect(result.isGitRepository).toBe(true);
    expect(result.canInitialize).toBe(false);
  });

  it("detects the exact registered root", () => {
    const dir = tempDir();
    const project = createProject({ name: "Cards", rootPath: dir }, db);

    const result = classifyWorkspace(dir, db);

    expect(result.situation).toBe("project-linked");
    expect(result.project?.id).toBe(project.id);
    expect(result.requiresConfirmation).toBe(false);
  });

  it("resolves a subfolder to its registered project", () => {
    const dir = tempDir();
    const project = createProject({ name: "Cards", rootPath: dir }, db);
    const nested = path.join(dir, "src", "domain");
    fs.mkdirSync(nested, { recursive: true });

    const result = classifyWorkspace(nested, db);

    expect(result.situation).toBe("project-subfolder");
    expect(result.project?.id).toBe(project.id);
  });

  it("does not let an umbrella project claim a nested independent repository", () => {
    const umbrella = tempDir();
    const project = createProject({ name: "Monorepo", rootPath: umbrella }, db);
    const nested = path.join(umbrella, "packages", "cards");
    fs.mkdirSync(path.join(nested, ".git"), { recursive: true });

    const result = classifyWorkspace(nested, db);

    expect(result.situation).toBe("nested-independent-repo");
    expect(result.project).toBeNull();
    expect(result.reason).toContain(project.name);
    expect(result.canInitialize).toBe(false);
  });

  it("treats the home directory as ambiguous and never initialisable", () => {
    const result = classifyWorkspace(os.homedir(), db);

    expect(result.situation).toBe("ambiguous");
    expect(result.canInitialize).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
  });

  it("never creates a project while classifying", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "README.md"), "# x");

    classifyWorkspace(dir, db);

    const row = db.query("SELECT COUNT(*) c FROM projects").get() as { c: number };
    expect(Number(row.c)).toBe(0);
  });
});
