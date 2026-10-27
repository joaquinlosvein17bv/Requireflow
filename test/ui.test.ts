import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { createHttpServer, resolveUiDirectory } from "../src/server/http.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("Dashboard resolution and packaging (RF-21)", () => {
  let db: Database;
  let originalCwd = process.cwd();
  const tempDirs: string[] = [];

  afterEach(() => {
    process.chdir(originalCwd);
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (db) db.close();
  });

  function foreignProject(): string {
    originalCwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-foreign-"));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, "src", "ui"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src", "ui", "index.html"),
      "<html><body>FOREIGN PROJECT UI</body></html>"
    );
    return dir;
  }

  it("serves the bundled dashboard without an explicit uiDir", async () => {
    db = createDatabase(":memory:");
    const server = createHttpServer({ port: 0, host: "127.0.0.1", db });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("<title>RequireFlow");
      expect(html).toContain('id="listTodo"');
    } finally {
      server.stop();
    }
  });

  it("never resolves the dashboard from another project's working directory", () => {
    const foreign = foreignProject();
    process.chdir(foreign);

    const resolved = resolveUiDirectory();
    const indexHtml = fs.readFileSync(path.join(resolved, "index.html"), "utf8");

    expect(indexHtml).not.toContain("FOREIGN PROJECT UI");
    expect(indexHtml).toContain("<title>RequireFlow");
  });

  it("keeps serving assets after the working directory changes", async () => {
    db = createDatabase(":memory:");
    const foreign = foreignProject();
    process.chdir(foreign);

    const server = createHttpServer({ port: 0, host: "127.0.0.1", db });
    try {
      const css = await fetch(`http://127.0.0.1:${server.port}/styles.css`);
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toContain("text/css");
      const body = await css.text();
      expect(body.length).toBeGreaterThan(100);
    } finally {
      server.stop();
    }
  });

  it("rejects path traversal outside the dashboard directory", async () => {
    db = createDatabase(":memory:");
    const server = createHttpServer({ port: 0, host: "127.0.0.1", db });
    try {
      const secret = path.join(os.tmpdir(), `rf-secret-${Date.now()}.txt`);
      fs.writeFileSync(secret, "TOPSECRET");
      const res = await fetch(
        `http://127.0.0.1:${server.port}/..%2f..%2f${encodeURIComponent(path.basename(secret))}`
      );
      const body = await res.text();
      expect(body).not.toContain("TOPSECRET");
      fs.rmSync(secret, { force: true });
    } finally {
      server.stop();
    }
  });
});

describe("Ideas view (fast capture)", () => {
  const UI_DIR = path.resolve(import.meta.dir, "..", "src", "ui");

  it("ships the ideas tab, the capture form and the project mode badge", () => {
    const html = fs.readFileSync(path.join(UI_DIR, "index.html"), "utf8");

    expect(html).toContain('data-tab="ideas"');
    expect(html).toContain('id="viewIdeas"');
    expect(html).toContain('id="formIdea"');
    expect(html).toContain('id="ideaTextInput"');
    expect(html).toContain('id="ideasList"');
    expect(html).toContain('id="projectModeBadge"');
  });

  it("renders idea text through the safe DOM helper, never as markup", () => {
    const source = fs.readFileSync(path.join(UI_DIR, "app.js"), "utf8");

    expect(source).toContain("async function loadIdeas");
    expect(source).toContain("function initIdeaCapture");
    expect(source).toContain("text: idea.original_text");
    expect(source).toContain("text: idea.title");
    expect(source).not.toMatch(/innerHTML\s*=\s*[^;]*idea\./);
  });
});

describe("Groups view (human flow)", () => {
  const UI_DIR = path.resolve(import.meta.dir, "..", "src", "ui");

  it("ships the groups tab, both views and the human confirmation modal", () => {
    const html = fs.readFileSync(path.join(UI_DIR, "index.html"), "utf8");

    expect(html).toContain('data-tab="groups"');
    expect(html).toContain('id="viewGroups"');
    expect(html).toContain('id="groupsList"');
    expect(html).toContain('id="epicsList"');
    expect(html).toContain('id="groupDetail"');
    expect(html).toContain('id="modalConfirm"');
    expect(html).toContain('id="confirmPhraseInput"');
  });

  it("renders group data through safe nodes and requires a typed phrase", () => {
    const source = fs.readFileSync(path.join(UI_DIR, "app.js"), "utf8");

    expect(source).toContain("async function loadGroups");
    expect(source).toContain("function renderGroupDetail");
    expect(source).toContain("function askHumanConfirmation");
    expect(source).toContain("APROBAR ${group.code}");
    expect(source).toContain("ACEPTAR ${group.code}");
    expect(source).not.toMatch(/innerHTML\s*=\s*[^;]*group\./);
  });
});
