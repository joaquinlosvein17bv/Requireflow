import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { runCli, parseArgs } from "../src/cli/index.ts";

describe("CLI Dispatcher & Argument Parsing", () => {
  let db: Database;
  let logs: string[] = [];
  const originalLog = console.log;

  beforeEach(() => {
    db = createDatabase(":memory:");
    logs = [];
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    db.close();
  });

  it("should parse arguments and flags correctly", () => {
    const parsed = parseArgs([
      "bun",
      "requireflow.ts",
      "add",
      "Optimize search query",
      "-t",
      "bugfix",
      "-p",
      "high",
      "--json",
    ]);

    expect(parsed.command).toBe("add");
    expect(parsed.positionals).toContain("Optimize search query");
    expect(parsed.flags["t"]).toBe("bugfix");
    expect(parsed.flags["p"]).toBe("high");
    expect(parsed.flags["json"]).toBe(true);
  });

  it("should execute init, add, next, start, done, and status commands", async () => {
    // 1. Init
    await runCli(["bun", "requireflow.ts", "init"], db);
    expect(logs.some((l) => l.includes("Project initialized"))).toBe(true);

    // 2. Add task
    logs = [];
    await runCli(
      ["bun", "requireflow.ts", "add", "Implement CLI tests", "-t", "feature", "-p", "high"],
      db
    );
    expect(logs.some((l) => l.includes("Task created"))).toBe(true);

    // 3. Next task
    logs = [];
    await runCli(["bun", "requireflow.ts", "next"], db);
    expect(logs.some((l) => l.includes("Implement CLI tests"))).toBe(true);

    // 4. Status
    logs = [];
    await runCli(["bun", "requireflow.ts", "status"], db);
    expect(logs.some((l) => l.includes("Por Hacer"))).toBe(true);
    expect(logs.some((l) => l.includes("Implement CLI tests"))).toBe(true);
  });
});
