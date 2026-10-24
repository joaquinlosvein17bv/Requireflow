import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { createProject } from "../src/domain/project.ts";
import { listSections } from "../src/domain/section.ts";
import { createTask, updateTask, getTask, listTasks } from "../src/domain/task.ts";

describe("Task / section project isolation (RF-06)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("rejects a section that belongs to another project", () => {
    const projectA = createProject({ name: "Alpha" }, db);
    const projectB = createProject({ name: "Beta" }, db);
    const sectionB = listSections(projectB.id, db)[0];
    if (!sectionB) throw new Error("Expected default sections for project B");

    let error: unknown;
    try {
      createTask(
        { projectId: projectA.id, sectionId: sectionB.id, title: "cross project" },
        db
      );
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("does not belong to project");

    // No side effects: nothing was written for either project.
    expect(listTasks(projectA.id, {}, db)).toHaveLength(0);
    expect(listTasks(projectB.id, {}, db)).toHaveLength(0);
  });

  it("rejects moving a task to a section of another project", () => {
    const projectA = createProject({ name: "Alpha" }, db);
    const projectB = createProject({ name: "Beta" }, db);
    const sectionA = listSections(projectA.id, db)[0];
    const sectionB = listSections(projectB.id, db)[0];
    if (!sectionA || !sectionB) throw new Error("Expected default sections");

    const task = createTask(
      { projectId: projectA.id, sectionId: sectionA.id, title: "keeps section" },
      db
    );

    expect(() => updateTask(task.id, { section_id: sectionB.id }, db)).toThrow(
      /does not belong to project/
    );
    expect(getTask(task.id, db)?.section_id).toBe(sectionA.id);
  });

  it("accepts its own section and allows clearing it", () => {
    const project = createProject({ name: "Alpha" }, db);
    const section = listSections(project.id, db)[0];
    if (!section) throw new Error("Expected default sections");

    const task = createTask(
      { projectId: project.id, sectionId: section.id, title: "own section" },
      db
    );
    expect(getTask(task.id, db)?.section_id).toBe(section.id);

    const cleared = updateTask(task.id, { section_id: null }, db);
    expect(cleared?.section_id).toBeNull();
  });

  it("rejects a section that does not exist", () => {
    const project = createProject({ name: "Alpha" }, db);

    expect(() =>
      createTask({ projectId: project.id, sectionId: "missing-section", title: "ghost" }, db)
    ).toThrow(/not found/);
    expect(listTasks(project.id, {}, db)).toHaveLength(0);
  });
});
