import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { createProject, deleteProject } from "../src/domain/project.ts";
import { createSection, deleteSection, listSections } from "../src/domain/section.ts";
import { createTask, completeTask, deleteTask } from "../src/domain/task.ts";
import { archiveDoneTasks } from "../src/domain/archive.ts";
import { listHistory, searchHistory } from "../src/domain/history.ts";

describe("History preservation (RF-05)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function archivedTask(options: { sectionName?: string } = {}) {
    const project = createProject({ name: "Archive Keep" }, db);
    const section = options.sectionName
      ? createSection({ projectId: project.id, name: options.sectionName }, db)
      : listSections(project.id, db)[0];

    const task = createTask(
      {
        projectId: project.id,
        sectionId: section?.id,
        title: "Permanent record",
        type: "bugfix",
      },
      db
    );
    completeTask(task.id, "fixed it", db);
    archiveDoneTasks(project.id, true, 0, db);

    return { project, section, task };
  }

  it("keeps the history row when the task is deleted", () => {
    const { task, project } = archivedTask();

    expect(deleteTask(task.id, db)).toBe(true);
    expect(db.query("SELECT COUNT(*) as c FROM tasks WHERE id = ?").get(task.id)).toEqual({
      c: 0,
    });

    const page = listHistory(project.id, 1, 10, db);
    expect(page.total).toBe(1);
    const row = page.items[0];
    expect(row?.task_id).toBeNull();
    expect(row?.title).toBe("Permanent record");
    expect(row?.notes).toBe("fixed it");
    expect(row?.project_id).toBe(project.id);

    // Full-text search still resolves the record.
    const found = searchHistory(project.id, "fixed", 10, db);
    expect(found).toHaveLength(1);
  });

  it("keeps the section name snapshot when the section is deleted", () => {
    const { section, project } = archivedTask({ sectionName: "Pagos" });
    if (!section) throw new Error("Expected a section");

    expect(deleteSection(section.id, db)).toBe(true);

    const page = listHistory(project.id, 1, 10, db);
    expect(page.items[0]?.section_name).toBe("Pagos");
  });

  it("still removes history when the whole project is deleted", () => {
    const { project } = archivedTask();
    expect(deleteProject(project.id, db)).toBe(true);

    expect(listHistory(project.id, 1, 10, db).total).toBe(0);
    expect(searchHistory(project.id, "fixed", 10, db)).toHaveLength(0);
  });

  it("records the project so activity can be reconstructed", () => {
    const { project, task } = archivedTask();
    db.run("DELETE FROM tasks WHERE id = ?", [task.id]);

    const row = db
      .query("SELECT project_id, type, priority, cycle_time_seconds FROM history WHERE project_id = ?")
      .get(project.id) as {
      project_id: string;
      type: string;
      priority: string;
      cycle_time_seconds: number | null;
    };

    expect(row.project_id).toBe(project.id);
    expect(row.type).toBe("bugfix");
    expect(row.priority).toBe("medium");
  });
});
