import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { createProject, updateProject } from "../src/domain/project.ts";
import { createTask, completeTask, listTasks } from "../src/domain/task.ts";
import { archiveDoneTasks, autoArchiveAllProjects } from "../src/domain/archive.ts";
import { parseArgs } from "../src/cli/index.ts";
import { flagToBoolean } from "../src/cli/flags.ts";
import { listHistory } from "../src/domain/history.ts";

describe("Archive force semantics (RF-07)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("does not archive a fresh completion unless forced", () => {
    const project = createProject({ name: "Threshold" }, db);
    const task = createTask({ projectId: project.id, title: "fresh" }, db);
    completeTask(task.id, "done", db);

    const result = archiveDoneTasks(project.id, false, 24, db);
    expect(result.archivedCount).toBe(0);
    expect(listTasks(project.id, { status: "done" }, db)).toHaveLength(1);
  });

  it("archives once the threshold is reached (controlled clock)", () => {
    const project = createProject({ name: "Clock" }, db);
    const task = createTask({ projectId: project.id, title: "old" }, db);
    completeTask(task.id, "done", db);

    const justBefore = new Date(Date.now() + 23 * 3600 * 1000);
    expect(archiveDoneTasks(project.id, false, 24, db, justBefore).archivedCount).toBe(0);

    const after = new Date(Date.now() + 25 * 3600 * 1000);
    expect(archiveDoneTasks(project.id, false, 24, db, after).archivedCount).toBe(1);
    expect(listTasks(project.id, { status: "done" }, db)).toHaveLength(0);
  });

  it("forces the flush only when explicitly requested", () => {
    const project = createProject({ name: "Force" }, db);
    const task = createTask({ projectId: project.id, title: "immediate" }, db);
    completeTask(task.id, "done", db);

    const result = archiveDoneTasks(project.id, true, undefined, db);
    expect(result.archivedCount).toBe(1);
  });

  it("honours a per-project archive threshold", () => {
    const project = createProject({ name: "Per Project", archiveThresholdHours: 1 }, db);
    const task = createTask({ projectId: project.id, title: "one hour" }, db);
    completeTask(task.id, "done", db);

    const after = new Date(Date.now() + 90 * 60 * 1000);
    expect(archiveDoneTasks(project.id, false, undefined, db, after).archivedCount).toBe(1);

    updateProject(project.id, { archive_threshold_hours: 72 }, db);
    const other = createTask({ projectId: project.id, title: "another" }, db);
    completeTask(other.id, "done", db);
    expect(archiveDoneTasks(project.id, false, undefined, db, after).archivedCount).toBe(0);
  });

  it("keeps the CLI force flag opt-in", () => {
    const plain = parseArgs(["bun", "rf", "archive"]);
    const forced = parseArgs(["bun", "rf", "archive", "--force"]);
    const explicitFalse = parseArgs(["bun", "rf", "archive", "--force=false"]);

    expect(flagToBoolean(plain.flags["force"])).toBe(false);
    expect(flagToBoolean(forced.flags["force"])).toBe(true);
    expect(flagToBoolean(explicitFalse.flags["force"])).toBe(false);
    expect(flagToBoolean(explicitFalse.flags["force"], true)).toBe(false);
    expect(flagToBoolean(undefined)).toBe(false);
    expect(() => flagToBoolean("maybe")).toThrow(/Invalid boolean value/);
  });
});

describe("Automatic archival (RF-08)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("archives only tasks past their project threshold", () => {
    const fastProject = createProject({ name: "Fast", archiveThresholdHours: 1 }, db);
    const slowProject = createProject({ name: "Slow", archiveThresholdHours: 48 }, db);

    const fastTask = createTask({ projectId: fastProject.id, title: "fast" }, db);
    completeTask(fastTask.id, "done", db);
    const slowTask = createTask({ projectId: slowProject.id, title: "slow" }, db);
    completeTask(slowTask.id, "done", db);

    const twoHoursLater = new Date(Date.now() + 2 * 3600 * 1000);
    const summary = autoArchiveAllProjects(db, twoHoursLater);

    expect(summary.archivedCount).toBe(1);
    expect(summary.taskIds).toContain(fastTask.id);
    expect(listTasks(slowProject.id, { status: "done" }, db)).toHaveLength(1);
    expect(listHistory(fastProject.id, 1, 10, db).total).toBe(1);
  });

  it("is idempotent when run repeatedly", () => {
    const project = createProject({ name: "Repeat", archiveThresholdHours: 0 }, db);
    const task = createTask({ projectId: project.id, title: "repeat" }, db);
    completeTask(task.id, "done", db);

    const later = new Date(Date.now() + 60_000);
    const first = autoArchiveAllProjects(db, later);
    const second = autoArchiveAllProjects(db, later);

    expect(first.archivedCount).toBe(1);
    expect(second.archivedCount).toBe(0);
    expect(listHistory(project.id, 1, 10, db).total).toBe(1);
  });
});
