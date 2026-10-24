import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { runCli } from "../src/cli/index.ts";
import { createProject, listProjects } from "../src/domain/project.ts";
import { listTasks } from "../src/domain/task.ts";

describe("CLI argument validation (RF-19)", () => {
  let db: Database;
  let errors: string[];
  let logs: string[];
  const originalError = console.error;
  const originalLog = console.log;

  beforeEach(() => {
    db = createDatabase(":memory:");
    errors = [];
    logs = [];
    console.error = (...args: any[]) => {
      errors.push(args.join(" "));
    };
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
    };
    process.exitCode = 0;
  });

  afterEach(() => {
    console.error = originalError;
    console.log = originalLog;
    process.exitCode = 0;
    db.close();
  });

  async function run(...args: string[]): Promise<void> {
    await runCli(["bun", "requireflow", ...args], db);
  }

  it("rejects an unknown task type without writing", async () => {
    await run("add", "task with bad type", "-t", "banana");

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Invalid type");
    expect(errors.join("\n")).toContain("feature");
    expect(listTasks(resolveProjectId(), {}, db)).toHaveLength(0);
  });

  it("rejects an unknown priority without writing", async () => {
    await run("add", "task with bad priority", "-p", "urgent");

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Invalid priority");
    expect(listTasks(resolveProjectId(), {}, db)).toHaveLength(0);
  });

  it("accepts valid type and priority", async () => {
    await run("add", "valid task", "-t", "bugfix", "-p", "high");

    expect(process.exitCode).toBe(0);
    const tasks = listTasks(resolveProjectId(), {}, db);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.type).toBe("bugfix");
    expect(tasks[0]?.priority).toBe("high");
  });

  it("rejects a non numeric port before binding", async () => {
    await run("ui", "--port", "abc");

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Invalid --port");
    expect(logs.join("\n")).not.toContain("HTTP Server running");
  });

  it("rejects an out of range port", async () => {
    await run("ui", "--port=70000");

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Invalid --port");
  });

  it("rejects a negative archive threshold", async () => {
    await run("archive", "--threshold", "-5");

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Invalid --threshold");
  });

  it("rejects an invalid stats window", async () => {
    await run("stats", "--days", "0");

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Invalid --days");
  });

  it("rejects an unknown command", async () => {
    await run("frobnicate");

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Unknown command");
  });

  it("reports a missing task instead of crashing", async () => {
    await run("start", "does-not-exist");

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Task not found");
  });

  function resolveProjectId(): string {
    const projects = listProjects(db);
    if (projects.length === 0) {
      return createProject({ name: "cli-validation" }, db).id;
    }
    return projects[0]!.id;
  }
});
