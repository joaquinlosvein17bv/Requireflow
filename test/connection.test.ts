import { describe, it, expect, afterEach } from "bun:test";
import { getDatabase, closeDatabase } from "../src/db/connection.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("Database connection lifecycle (RF-17)", () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    closeDatabase();
    for (const file of tempFiles.splice(0)) {
      for (const suffix of ["", "-wal", "-shm"]) {
        fs.rmSync(file + suffix, { force: true });
      }
    }
  });

  function tempDbPath(label: string): string {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), `rf-conn-${label}-`)),
      "requireflow.db"
    );
    tempFiles.push(file);
    return file;
  }

  it("does not close a connection owned by another consumer", () => {
    const pathA = tempDbPath("a");
    const pathB = tempDbPath("b");

    const dbA = getDatabase(pathA);
    getDatabase(pathB);

    // The second consumer must not have invalidated the first one.
    const row = dbA.query("SELECT 1 as ok").get() as { ok: number };
    expect(row.ok).toBe(1);
  });

  it("returns the same instance for the same path", () => {
    const file = tempDbPath("same");
    const first = getDatabase(file);
    const second = getDatabase(file);
    expect(second).toBe(first);
  });

  it("keeps writes isolated per database file", () => {
    const pathA = tempDbPath("isolated-a");
    const pathB = tempDbPath("isolated-b");

    const dbA = getDatabase(pathA);
    const dbB = getDatabase(pathB);

    dbA.run("INSERT INTO projects (id, name) VALUES ('p-a', 'Project A')");
    dbB.run("INSERT INTO projects (id, name) VALUES ('p-b', 'Project B')");

    expect(dbA.query("SELECT name FROM projects").all()).toEqual([{ name: "Project A" }]);
    expect(dbB.query("SELECT name FROM projects").all()).toEqual([{ name: "Project B" }]);
  });

  it("closes only the requested database", () => {
    const pathA = tempDbPath("close-a");
    const pathB = tempDbPath("close-b");

    getDatabase(pathA);
    const dbB = getDatabase(pathB);

    closeDatabase(pathA);

    expect(dbB.query("SELECT 1 as ok").get()).toEqual({ ok: 1 });
    expect(getDatabase(pathB)).toBe(dbB);
  });
});
