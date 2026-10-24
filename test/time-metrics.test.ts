import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { createProject } from "../src/domain/project.ts";
import { createTask, startTask, completeTask, getTask } from "../src/domain/task.ts";
import { listSections } from "../src/domain/section.ts";
import { calculateProjectMetrics } from "../src/domain/efficiency.ts";
import { isCanonicalIso, nowIso } from "../src/domain/time.ts";

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

describe("Canonical timestamps (RF-11)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("writes every timestamp as ISO 8601 UTC", () => {
    const project = createProject({ name: "Time App" }, db);
    expect(isCanonicalIso(project.created_at)).toBe(true);
    expect(isCanonicalIso(project.updated_at)).toBe(true);

    const section = listSections(project.id, db)[0];
    if (!section) throw new Error("Expected default sections");
    expect(isCanonicalIso(section.created_at)).toBe(true);

    const task = createTask({ projectId: project.id, title: "Stamp" }, db);
    expect(isCanonicalIso(task.created_at)).toBe(true);
    expect(isCanonicalIso(task.updated_at)).toBe(true);

    const started = startTask(task.id, db);
    expect(isCanonicalIso(started?.started_at ?? "")).toBe(true);

    const completed = completeTask(task.id, "done", db);
    expect(isCanonicalIso(completed?.completed_at ?? "")).toBe(true);
  });

  it("computes a ten minute cycle time regardless of the machine timezone", () => {
    const project = createProject({ name: "Cycle App" }, db);
    const task = createTask({ projectId: project.id, title: "Ten minutes" }, db);
    startTask(task.id, db);

    db.run("UPDATE tasks SET started_at = ? WHERE id = ?", [minutesAgo(10), task.id]);

    const completed = completeTask(task.id, "finished", db);
    expect(completed?.cycle_time_seconds).toBeGreaterThanOrEqual(598);
    expect(completed?.cycle_time_seconds).toBeLessThanOrEqual(602);
  });

  it("computes lead time without a timezone offset", () => {
    const project = createProject({ name: "Lead App" }, db);
    const task = createTask({ projectId: project.id, title: "Lead" }, db);

    db.run("UPDATE tasks SET created_at = ? WHERE id = ?", [minutesAgo(10), task.id]);

    startTask(task.id, db);
    completeTask(task.id, "done", db);

    const metrics = calculateProjectMetrics(project.id, 30, db);
    expect(metrics.totalCompleted).toBe(1);
    expect(metrics.avgLeadTimeSeconds).toBeGreaterThanOrEqual(598);
    expect(metrics.avgLeadTimeSeconds).toBeLessThanOrEqual(602);
  });
});

describe("Cycle based metrics (RF-09, RF-22)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("keeps one cycle per completion when a task is reopened", () => {
    const project = createProject({ name: "Rework App" }, db);
    const task = createTask({ projectId: project.id, title: "Rework" }, db);

    startTask(task.id, db);
    db.run("UPDATE tasks SET started_at = ? WHERE id = ?", [minutesAgo(30), task.id]);
    completeTask(task.id, "first", db);

    // Reopen and complete again after a different duration.
    db.run(
      "UPDATE tasks SET status = 'todo', started_at = NULL, completed_at = NULL WHERE id = ?",
      [task.id]
    );
    startTask(task.id, db);
    db.run("UPDATE tasks SET started_at = ? WHERE id = ?", [minutesAgo(10), task.id]);
    completeTask(task.id, "second", db);

    const cycles = db
      .query("SELECT cycle_time_seconds FROM task_cycles WHERE task_id = ? ORDER BY completed_at")
      .all(task.id) as Array<{ cycle_time_seconds: number }>;

    expect(cycles).toHaveLength(2);
    expect(cycles[0]?.cycle_time_seconds).toBeGreaterThanOrEqual(1798);
    expect(cycles[1]?.cycle_time_seconds).toBeGreaterThanOrEqual(598);

    const metrics = calculateProjectMetrics(project.id, 30, db);
    expect(metrics.totalCompleted).toBe(2);
    // Average of ~1800s and ~600s.
    expect(metrics.avgCycleTimeSeconds).toBeGreaterThanOrEqual(1198);
    expect(metrics.avgCycleTimeSeconds).toBeLessThanOrEqual(1202);
  });

  it("excludes completions outside the requested window", () => {
    const project = createProject({ name: "Window App" }, db);

    const inside = createTask({ projectId: project.id, title: "inside" }, db);
    startTask(inside.id, db);
    completeTask(inside.id, "done", db);
    db.run("UPDATE task_cycles SET completed_at = ? WHERE task_id = ?", [daysAgo(29), inside.id]);

    const outside = createTask({ projectId: project.id, title: "outside" }, db);
    startTask(outside.id, db);
    completeTask(outside.id, "done", db);
    db.run("UPDATE task_cycles SET completed_at = ? WHERE task_id = ?", [daysAgo(31), outside.id]);

    // Same calendar day as the cutoff, but 12 hours earlier: string comparison
    // against datetime() used to count this one (RF-11).
    const boundary = createTask({ projectId: project.id, title: "boundary" }, db);
    startTask(boundary.id, db);
    completeTask(boundary.id, "done", db);
    const cutoff = daysAgo(30);
    const sameDayEarlier = `${cutoff.slice(0, 10)}T02:00:00.000Z`;
    db.run("UPDATE task_cycles SET completed_at = ? WHERE task_id = ?", [
      sameDayEarlier,
      boundary.id,
    ]);

    const metrics = calculateProjectMetrics(project.id, 30, db);
    expect(metrics.totalCompleted).toBe(1);
  });

  it("returns a daily series that matches the requested window", () => {
    const project = createProject({ name: "Trends App" }, db);
    const task = createTask({ projectId: project.id, title: "trend" }, db);
    startTask(task.id, db);
    completeTask(task.id, "done", db);

    const week = calculateProjectMetrics(project.id, 7, db);
    expect(week.dailyTrends).toHaveLength(7);
    expect(week.timeWindowDays).toBe(7);
    expect(week.dailyTrends.at(-1)?.completedCount).toBe(1);

    const month = calculateProjectMetrics(project.id, 30, db);
    expect(month.dailyTrends).toHaveLength(30);

    const quarter = calculateProjectMetrics(project.id, 90, db);
    expect(quarter.dailyTrends).toHaveLength(90);
  });

  it("counts distribution, bugfix velocity and throughput from cycles", () => {
    const project = createProject({ name: "Stats App" }, db);
    const feature = createTask({ projectId: project.id, title: "f", type: "feature" }, db);
    const fix = createTask({ projectId: project.id, title: "b", type: "fix" }, db);

    startTask(feature.id, db);
    completeTask(feature.id, "done", db);
    startTask(fix.id, db);
    db.run("UPDATE tasks SET started_at = ? WHERE id = ?", [minutesAgo(5), fix.id]);
    completeTask(fix.id, "done", db);

    const metrics = calculateProjectMetrics(project.id, 30, db);
    expect(metrics.distribution.feature).toBe(1);
    expect(metrics.distribution.bugfix).toBe(1);
    expect(metrics.throughput.today).toBe(2);
    expect(metrics.throughput.thisWeek).toBe(2);
    expect(metrics.throughput.allTime).toBe(2);
    expect(metrics.formattedBugfixVelocity).not.toBe("0s");
  });

  it("does not count an incomplete task as completed", () => {
    const project = createProject({ name: "Open App" }, db);
    const task = createTask({ projectId: project.id, title: "open" }, db);
    startTask(task.id, db);

    const metrics = calculateProjectMetrics(project.id, 30, db);
    expect(metrics.totalCompleted).toBe(0);
    expect(metrics.totalActive).toBe(1);
    expect(getTask(task.id, db)?.status).toBe("in_progress");
    expect(nowIso()).toMatch(/Z$/);
  });
});
