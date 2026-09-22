import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import {
  createProject,
  resolveCurrentProject,
  listProjects,
} from "../src/domain/project.ts";
import {
  createSection,
  listSections,
} from "../src/domain/section.ts";
import {
  createTask,
  getTask,
  listTasks,
  getNextTask,
  startTask,
  completeTask,
  updateTask,
} from "../src/domain/task.ts";
import { archiveDoneTasks } from "../src/domain/archive.ts";
import { searchHistory, listHistory } from "../src/domain/history.ts";
import { calculateProjectMetrics } from "../src/domain/efficiency.ts";

describe("Domain Services", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("Projects & Sections", () => {
    it("should create a project and auto-seed default sections", () => {
      const project = createProject({ name: "Alpha App", description: "Alpha description" }, db);
      expect(project.id).toBeDefined();
      expect(project.name).toBe("Alpha App");

      const sections = listSections(project.id, db);
      expect(sections.length).toBe(4);
      expect(sections.map((s) => s.name)).toContain("General");
      expect(sections.map((s) => s.name)).toContain("Frontend");
      expect(sections.map((s) => s.name)).toContain("Backend");
      expect(sections.map((s) => s.name)).toContain("Bugfixes");
    });

    it("should resolve project from current directory", () => {
      const project = resolveCurrentProject(process.cwd(), db);
      expect(project).toBeDefined();
      expect(project.name.length).toBeGreaterThan(0);
    });
  });

  describe("Tasks Lifecycle", () => {
    it("should create tasks with priority and retrieve the highest priority task next", () => {
      const project = createProject({ name: "Task App" }, db);
      const sections = listSections(project.id, db);

      createTask(
        { projectId: project.id, title: "Low priority item", priority: "low", sectionId: sections[0].id },
        db
      );
      createTask(
        { projectId: project.id, title: "Blocker bug", priority: "blocker", type: "bugfix", sectionId: sections[3].id },
        db
      );
      createTask(
        { projectId: project.id, title: "High priority feature", priority: "high", sectionId: sections[1].id },
        db
      );

      const nextTask = getNextTask(project.id, undefined, db);
      expect(nextTask).not.toBeNull();
      expect(nextTask?.title).toBe("Blocker bug");
      expect(nextTask?.priority).toBe("blocker");
    });

    it("should transition through startTask and completeTask calculating cycle time", async () => {
      const project = createProject({ name: "Lifecycle App" }, db);
      const task = createTask(
        { projectId: project.id, title: "Build auth module", priority: "high" },
        db
      );

      expect(task.status).toBe("todo");
      expect(task.started_at).toBeNull();

      const started = startTask(task.id, db);
      expect(started?.status).toBe("in_progress");
      expect(started?.started_at).not.toBeNull();

      // Backdate started_at to test cycle time calculation
      const pastDate = new Date(Date.now() - 3600 * 1000).toISOString(); // 1 hour ago
      db.run("UPDATE tasks SET started_at = ? WHERE id = ?", [pastDate, task.id]);

      const completed = completeTask(task.id, "Auth implemented with OAuth2", db);
      expect(completed?.status).toBe("done");
      expect(completed?.completed_at).not.toBeNull();
      expect(completed?.notes).toBe("Auth implemented with OAuth2");
      expect(completed?.cycle_time_seconds).toBeGreaterThanOrEqual(3590);
    });
  });

  describe("Dual Archival & History", () => {
    it("should perform manual archive flush and populate history & FTS search", () => {
      const project = createProject({ name: "Archive App" }, db);
      const task1 = createTask({ projectId: project.id, title: "Optimize DB connection pool" }, db);
      const task2 = createTask({ projectId: project.id, title: "Fix CSS flexbox alignment" }, db);

      completeTask(task1.id, "Switched to WAL mode", db);
      completeTask(task2.id, "Adjusted justify-content", db);

      const doneTasks = listTasks(project.id, { status: "done" }, db);
      expect(doneTasks.length).toBe(2);

      // Manual flush
      const result = archiveDoneTasks(project.id, true, 24, db);
      expect(result.archivedCount).toBe(2);

      // Active board should now have 0 done tasks
      const remainingDone = listTasks(project.id, { status: "done" }, db);
      expect(remainingDone.length).toBe(0);

      // History should have 2 entries
      const historyPage = listHistory(project.id, 1, 10, db);
      expect(historyPage.total).toBe(2);
      expect(historyPage.items.map((i) => i.title)).toContain("Optimize DB connection pool");

      // Search via FTS
      const searchRes = searchHistory(project.id, "WAL", 10, db);
      expect(searchRes.length).toBe(1);
      expect(searchRes[0].title).toBe("Optimize DB connection pool");
    });

    it("should automatically archive only tasks older than threshold", () => {
      const project = createProject({ name: "Threshold App" }, db);
      const taskFresh = createTask({ projectId: project.id, title: "Fresh completion" }, db);
      const taskStale = createTask({ projectId: project.id, title: "Stale completion" }, db);

      completeTask(taskFresh.id, undefined, db);
      completeTask(taskStale.id, undefined, db);

      // Backdate taskStale completion to 30 hours ago
      const staleTime = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
      db.run("UPDATE tasks SET completed_at = ? WHERE id = ?", [staleTime, taskStale.id]);

      // Auto archive with 24 hours threshold
      const result = archiveDoneTasks(project.id, false, 24, db);
      expect(result.archivedCount).toBe(1);
      expect(result.taskIds).toContain(taskStale.id);

      const doneRemaining = listTasks(project.id, { status: "done" }, db);
      expect(doneRemaining.length).toBe(1);
      expect(doneRemaining[0].id).toBe(taskFresh.id);
    });
  });

  describe("Efficiency Metrics", () => {
    it("should compute cycle time, throughput and distribution metrics", () => {
      const project = createProject({ name: "Metrics App" }, db);
      const task1 = createTask({ projectId: project.id, title: "New login screen", type: "feature" }, db);
      const task2 = createTask({ projectId: project.id, title: "Crash on invalid token", type: "fix" }, db);

      startTask(task1.id, db);
      startTask(task2.id, db);

      completeTask(task1.id, "Implemented UI", db);
      completeTask(task2.id, "Added try/catch", db);

      const metrics = calculateProjectMetrics(project.id, 30, db);
      expect(metrics.totalCompleted).toBe(2);
      expect(metrics.distribution.feature).toBe(1);
      expect(metrics.distribution.bugfix).toBe(1);
      expect(metrics.throughput.allTime).toBe(2);
    });
  });
});
