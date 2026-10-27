import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../src/db/connection.ts";
import {
  classifyWorkspace,
  createProject,
  detectProject,
  getOrCreateProject,
  getProject,
  listProjects,
  resolveCurrentProject,
  resolveRegisteredProject,
} from "../src/domain/project.ts";
import { createIncrement, listIncrements } from "../src/domain/backlog/increment.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { runCli } from "../src/cli/index.ts";

/**
 * Regression cover for the project-resolution defect.
 *
 * The CLI used to resolve the active project from the nearest ancestor git root
 * and create it when missing, so a registered folder inside an umbrella
 * repository was silently mapped to the umbrella and reads manufactured
 * phantom projects.
 */
describe("Project resolution", () => {
  let db: Database;
  let workspace: string;
  let umbrellaRoot: string;
  let appRoot: string;
  let appSrc: string;
  let otherRoot: string;
  let looseRoot: string;
  let outsideRoot: string;
  let standaloneRoot: string;
  const originalLog = console.log;
  const originalError = console.error;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    db = createDatabase(":memory:");
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rf-resolution-"));
    umbrellaRoot = path.join(workspace, "umbrella");
    appRoot = path.join(umbrellaRoot, "app");
    appSrc = path.join(appRoot, "src");
    otherRoot = path.join(umbrellaRoot, "other");
    looseRoot = path.join(umbrellaRoot, "loose");
    outsideRoot = path.join(workspace, "outside");
    standaloneRoot = path.join(workspace, "standalone");

    fs.mkdirSync(path.join(umbrellaRoot, ".git"), { recursive: true });
    fs.mkdirSync(appSrc, { recursive: true });
    fs.mkdirSync(otherRoot, { recursive: true });
    fs.mkdirSync(looseRoot, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });
    fs.mkdirSync(standaloneRoot, { recursive: true });

    logs = [];
    errors = [];
    console.log = (...args: any[]) => logs.push(args.join(" "));
    console.error = (...args: any[]) => errors.push(args.join(" "));
    process.exitCode = 0;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = 0;
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  async function run(cwd: string, ...args: string[]): Promise<void> {
    await runCli(["bun", "requireflow", ...args], db, cwd);
  }

  it("resolves the registered project from its own root", () => {
    const app = getOrCreateProject("app", appRoot, db, "product");

    expect(resolveRegisteredProject(appRoot, db).id).toBe(app.id);
    expect(detectProject(appRoot, db).source).toBe("exact");
  });

  it("resolves a subdirectory to its registered project, not the ancestor git root", () => {
    const app = getOrCreateProject("app", appRoot, db, "product");
    const umbrella = getOrCreateProject("umbrella", umbrellaRoot, db);

    expect(resolveRegisteredProject(appSrc, db).id).toBe(app.id);
    expect(resolveRegisteredProject(appSrc, db).id).not.toBe(umbrella.id);
  });

  it("prefers a registered project over the umbrella git root it lives in", () => {
    const umbrella = getOrCreateProject("umbrella", umbrellaRoot, db);
    const app = getOrCreateProject("app", appRoot, db, "product");

    expect(detectProject(appRoot, db).project?.id).toBe(app.id);
    expect(detectProject(appRoot, db).project?.id).not.toBe(umbrella.id);
  });

  it("selects the most specific registered root when several contain the folder", () => {
    getOrCreateProject("umbrella", umbrellaRoot, db);
    const app = getOrCreateProject("app", appRoot, db);
    const other = getOrCreateProject("other", otherRoot, db);

    expect(resolveRegisteredProject(appSrc, db).id).toBe(app.id);
    expect(resolveRegisteredProject(otherRoot, db).id).toBe(other.id);
  });

  it("still resolves a plain registered folder without any git repository", () => {
    const standalone = getOrCreateProject("standalone", standaloneRoot, db, "product");

    expect(resolveRegisteredProject(standaloneRoot, db).id).toBe(standalone.id);
    expect(resolveRegisteredProject(path.join(standaloneRoot, "nested"), db).id).toBe(standalone.id);
  });

  it("resolves a subdirectory of a registered project to that project", () => {
    const umbrella = getOrCreateProject("umbrella", umbrellaRoot, db);

    expect(resolveRegisteredProject(looseRoot, db).id).toBe(umbrella.id);
    expect(detectProject(looseRoot, db).source).toBe("nested");
  });

  it("refuses a folder with no registered project and creates nothing", () => {
    getOrCreateProject("umbrella", umbrellaRoot, db);
    const before = listProjects(db).length;

    expect(() => resolveRegisteredProject(outsideRoot, db)).toThrow(
      /No project is registered for ".*outside"/
    );
    expect(listProjects(db).length).toBe(before);
  });

  it("keeps read commands from creating projects", async () => {
    getOrCreateProject("umbrella", umbrellaRoot, db);
    const before = listProjects(db).map((project) => project.id).sort();

    await run(outsideRoot, "group", "list");
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("No project is registered");

    process.exitCode = 0;
    errors = [];
    await run(outsideRoot, "status");
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("No project is registered");

    process.exitCode = 0;
    errors = [];
    await run(outsideRoot, "backlog");
    expect(process.exitCode).toBe(1);

    expect(listProjects(db).map((project) => project.id).sort()).toEqual(before);
  });

  it("makes mutating group commands act on the registered project, not the umbrella", async () => {
    const umbrella = getOrCreateProject("umbrella", umbrellaRoot, db);
    const app = getOrCreateProject("app", appRoot, db, "product");
    createIncrement({ projectId: app.id, code: "G01", goal: "Objetivo de G01" }, db);

    await run(appSrc, "group", "list");

    expect(process.exitCode).toBe(0);
    expect(logs.join("\n")).toContain("app (product)");
    expect(logs.join("\n")).toContain("G01");
    expect(logs.join("\n")).not.toContain("umbrella");

    await run(appSrc, "mode", "legacy");

    expect(getProject(app.id, db)?.mode).toBe("legacy");
    expect(getProject(umbrella.id, db)?.mode).toBe("legacy");
  });

  it("resolves the right project before an approval can even start", async () => {
    const umbrella = getOrCreateProject("umbrella", umbrellaRoot, db);
    const app = getOrCreateProject("app", appRoot, db, "product");
    const group = createIncrement({ projectId: app.id, code: "G01", goal: "Objetivo de G01" }, db);

    await run(appSrc, "group", "approve", "G01");

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("interactive terminal");
    expect(getProject(umbrella.id, db)?.id).toBe(umbrella.id);

    const stored = db.query("SELECT status FROM increments WHERE id = ?").get(group.id) as {
      status: string;
    };
    expect(stored.status).toBe("planificado");
  });

  it("keeps the legacy bootstrap on the caller's folder instead of the git root", () => {
    const created = resolveCurrentProject(outsideRoot, db);

    expect(created.mode).toBe("legacy");
    expect(created.root_path).toBe(outsideRoot);
    expect(created.root_key).toBe(
      path.resolve(outsideRoot).replace(/\\/g, "/").toLowerCase()
    );
    expect(created.root_key).not.toBe(path.resolve(umbrellaRoot).replace(/\\/g, "/").toLowerCase());
    expect(listProjects(db)).toHaveLength(1);
  });

  it("adopts an unlinked legacy project by its unique name without duplicating it", () => {
    const legacy = createProject({ name: "app" }, db);
    expect(legacy.root_path).toBeNull();

    const resolved = resolveCurrentProject(appRoot, db);

    expect(resolved.id).toBe(legacy.id);
    expect(resolved.root_path).toBe(appRoot);
    expect(listProjects(db)).toHaveLength(1);
  });

  it("keeps every provisional group alive after resolving from a subdirectory", () => {
    const app = getOrCreateProject("app", appRoot, db, "product");
    for (const code of ["G01", "G02", "G03", "G04", "G05"]) {
      createIncrement({ projectId: app.id, code, goal: `Objetivo de ${code}` }, db);
    }

    const resolved = resolveRegisteredProject(appSrc, db);

    expect(resolved.id).toBe(app.id);
    expect(listIncrements(resolved.id, db).map((group) => group.code)).toEqual([
      "G01",
      "G02",
      "G03",
      "G04",
      "G05",
    ]);
  });

  it("makes CLI, MCP and the dashboard agree on the same project", async () => {
    const app = getOrCreateProject("app", appRoot, db, "product");
    getOrCreateProject("umbrella", umbrellaRoot, db);

    const cli = resolveRegisteredProject(appSrc, db);
    const classified = classifyWorkspace(appSrc, db);
    const detected = detectProject(appSrc, db);

    const server = createMcpServer(db);
    const tools = (server as any)._registeredTools;
    const mcp = JSON.parse(
      (await tools["rf_project_detect"].handler({ cwd: appSrc })).content[0].text
    );

    expect(cli.id).toBe(app.id);
    expect(classified.project?.id).toBe(app.id);
    expect(detected.project?.id).toBe(app.id);
    expect(mcp.id).toBe(app.id);
  });
});
