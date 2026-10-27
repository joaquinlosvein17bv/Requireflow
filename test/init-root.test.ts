import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../src/db/connection.ts";
import {
  createProject,
  initializeProject,
  listProjects,
  normalizeRootPath,
} from "../src/domain/project.ts";

/**
 * RF-V2-01: initializing a new product must honour the folder the user
 * selected, even when that folder lives inside an ancestor Git repository.
 * No `git init` workaround is acceptable.
 */
describe("Project initialization root", () => {
  let db: Database;
  const created: string[] = [];

  function tempDir(prefix = "rf-init-"): string {
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

  it("initializes an empty folder inside an ancestor git repository at the folder", () => {
    const parent = tempDir();
    fs.mkdirSync(path.join(parent, ".git"));
    const child = path.join(parent, "CartasDigitales-Test");
    fs.mkdirSync(child);

    const result = initializeProject({ cwd: child, mode: "product" }, db);

    expect(result.situation).toBe("empty-new");
    expect(result.project.root_key).toBe(normalizeRootPath(child));
    expect(result.project.mode).toBe("product");
    expect(listProjects(db)).toHaveLength(1);
  });

  it("initializes a folder without git at the folder", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "package.json"), "{}");

    const result = initializeProject({ cwd: dir }, db);

    expect(result.project.root_key).toBe(normalizeRootPath(dir));
  });

  it("initializes an independent git repository at its root", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, "README.md"), "# repo");

    const result = initializeProject({ cwd: dir }, db);

    expect(result.project.root_key).toBe(normalizeRootPath(dir));
  });

  it("reuses an already registered project", () => {
    const dir = tempDir();
    const existing = createProject({ name: "Cards", rootPath: dir, mode: "product" }, db);

    const result = initializeProject({ cwd: dir }, db);

    expect(result.project.id).toBe(existing.id);
    expect(result.created).toBe(false);
  });

  it("reuses the project for a real subfolder of a registered project", () => {
    const dir = tempDir();
    const existing = createProject({ name: "Cards", rootPath: dir }, db);
    const nested = path.join(dir, "src", "domain");
    fs.mkdirSync(nested, { recursive: true });

    const result = initializeProject({ cwd: nested }, db);

    expect(result.project.id).toBe(existing.id);
    expect(result.situation).toBe("project-subfolder");
  });

  it("refuses a generic location and creates nothing", () => {
    expect(() => initializeProject({ cwd: os.homedir() }, db)).toThrow();
    expect(listProjects(db)).toHaveLength(0);
  });

  it("refuses a non-empty folder inside an ancestor git repository without explicit root", () => {
    const parent = tempDir();
    fs.mkdirSync(path.join(parent, ".git"));
    const child = path.join(parent, "app");
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(child, "index.ts"), "export {};");

    expect(() => initializeProject({ cwd: child }, db)).toThrow(/git repository/i);
    expect(listProjects(db)).toHaveLength(0);
  });

  it("accepts an explicit root for that ambiguous folder", () => {
    const parent = tempDir();
    fs.mkdirSync(path.join(parent, ".git"));
    const child = path.join(parent, "app");
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(child, "index.ts"), "export {};");

    const result = initializeProject({ cwd: child, explicitRoot: "." }, db);

    expect(result.project.root_key).toBe(normalizeRootPath(child));
  });

  it("refuses an explicit root that is a subfolder of a registered project", () => {
    const dir = tempDir();
    createProject({ name: "Cards", rootPath: dir }, db);
    const nested = path.join(dir, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });

    expect(() => initializeProject({ cwd: nested, explicitRoot: "." }, db)).toThrow(
      /belongs to project/i
    );
  });
});
