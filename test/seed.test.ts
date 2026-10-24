import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { createProject, listProjects } from "../src/domain/project.ts";
import { listTasks } from "../src/domain/task.ts";
import { listHistory } from "../src/domain/history.ts";
import { seedDemoData, DEMO_PROJECT_NAME } from "../src/db/seed.ts";

describe("Demo data isolation (RF-23)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("never deletes or overwrites real projects", () => {
    const real = createProject({ name: "Real project", rootPath: "C:/repos/real" }, db);
    createProject({ name: DEMO_PROJECT_NAME }, db);

    seedDemoData({ db });

    const projects = listProjects(db);
    expect(projects.map((p) => p.id)).toContain(real.id);
    expect(projects.filter((p) => p.name === DEMO_PROJECT_NAME)).toHaveLength(1);
  });

  it("is repeatable without duplicating the demo project", () => {
    const first = seedDemoData({ db });
    const second = seedDemoData({ db });

    const demoProjects = listProjects(db).filter((p) => p.name === DEMO_PROJECT_NAME);
    expect(demoProjects).toHaveLength(1);
    expect(first.projectId).toBe(second.projectId);
    expect(listTasks(first.projectId, { excludeArchived: false }, db)).toHaveLength(
      first.tasks
    );
    expect(second.tasks).toBe(first.tasks);
  });

  it("uses no filesystem paths that could collide with a real checkout", () => {
    const { projectId } = seedDemoData({ db });

    const project = listProjects(db).find((p) => p.id === projectId);
    expect(project?.root_path).toBeNull();
    expect(project?.root_key).toBeNull();
  });

  it("populates history so search and metrics are demonstrable", () => {
    const { projectId } = seedDemoData({ db });

    expect(listHistory(projectId, 1, 50, db).total).toBeGreaterThan(0);
  });

  it("only resets when explicitly asked", () => {
    const real = createProject({ name: "Another real project" }, db);
    seedDemoData({ db });
    seedDemoData({ db, reset: true });

    expect(listProjects(db).map((p) => p.id)).toContain(real.id);
  });
});
