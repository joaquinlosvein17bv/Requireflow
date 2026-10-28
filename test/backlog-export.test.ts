import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../src/db/connection.ts";
import { createProject } from "../src/domain/project.ts";
import {
  createWorkItem,
  updateWorkItem,
  type WorkItem,
} from "../src/domain/backlog/work-item.ts";
import { addAcceptanceCriterion, recordDecision } from "../src/domain/backlog/criteria.ts";
import {
  addStoryToIncrement,
  approveIncrement,
  createIncrement,
  updateIncrement,
} from "../src/domain/backlog/increment.ts";
import {
  deliverCorrection,
  reportDefect,
  startImplementation,
  submitImplementationEvidence,
} from "../src/domain/backlog/review.ts";
import {
  checkProjectBacklog,
  exportProjectBacklog,
} from "../src/domain/backlog/export.ts";

const HUMAN = "human:cli";
const ODD = "agent:odd";

describe("Deterministic V2 backlog Markdown export", () => {
  let db: Database;
  let projectId: string;
  let epicId: string;
  let outDir: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    projectId = createProject(
      { name: "Cartas Digitales", description: "Juego de cartas con mensajes", mode: "product" },
      db
    ).id;
    epicId = createWorkItem({ projectId, kind: "epic", title: "Crear cartas" }, db).id;
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-backlog-export-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  function readyStory(title: string): WorkItem {
    let story = createWorkItem(
      { projectId, kind: "story", title, description: `${title}: confirmado`, parentId: epicId },
      db
    );
    story = updateWorkItem(story.id, story.version, { status: "refined" }, "user:test", db);
    return updateWorkItem(story.id, story.version, { status: "ready" }, "user:test", db);
  }

  function approvedGroup(code: string, story: WorkItem, criterion: string) {
    let group = createIncrement({ projectId, code, goal: `Objetivo ${code}` }, db);
    addStoryToIncrement(group.id, story.id, "user:test", db);
    addAcceptanceCriterion({ incrementId: group.id, text: criterion, actor: HUMAN }, db);
    recordDecision(
      {
        projectId,
        incrementId: group.id,
        title: "Imagen de portada",
        question: "¿Se elige o se sube?",
        answer: "Se elige de un set predefinido",
        actor: HUMAN,
      },
      db
    );
    group = updateIncrement(group.id, group.version, { status: "en_refinamiento" }, HUMAN, db);
    group = updateIncrement(
      group.id,
      group.version,
      { status: "listo_para_aprobacion" },
      HUMAN,
      db
    );
    return approveIncrement(group.id, { expectedVersion: group.version, actor: HUMAN }, db);
  }

  it("exports the whole backlog with counts, manifest and verification", () => {
    const story = readyStory("Abrir carta");
    const group = approvedGroup("G01", story, "La carta se abre");
    startImplementation(group.id, ODD, db);
    submitImplementationEvidence({ incrementId: group.id, actor: ODD, evidence: "42 tests" }, db);
    reportDefect(
      { incrementId: group.id, actor: HUMAN, description: "No se ve la imagen" },
      db
    );
    deliverCorrection({ incrementId: group.id, actor: ODD, evidence: "Corregido" }, db);

    const result = exportProjectBacklog({ projectId, outDir }, db);

    expect(result.verified).toBe(true);
    expect(result.counts.groups).toBe(1);
    expect(result.counts.stories).toBe(1);
    expect(result.counts.criteria).toBe(1);
    expect(result.counts.decisions).toBe(1);
    expect(result.counts.reviews).toBe(2);

    const readme = fs.readFileSync(path.join(outDir, "README.md"), "utf8");
    expect(readme).toContain("Cartas Digitales");
    expect(readme).toContain("Schema version:** v8");
    expect(readme).toContain("[G01](./groups/G01.md)");

    const groupFile = fs.readFileSync(path.join(outDir, "groups", "G01.md"), "utf8");
    expect(groupFile).toContain("Objetivo G01");
    expect(groupFile).toContain("AC-G01-001");
    expect(groupFile).toContain("Se elige de un set predefinido");
    expect(groupFile).toContain("Cycle 1");
    expect(groupFile).toContain("No se ve la imagen");
    expect(groupFile).toContain("Approved scope revisions");
    expect(groupFile).toContain("Revision 1");

    const decisions = fs.readFileSync(path.join(outDir, "decisions.md"), "utf8");
    expect(decisions).toContain("D001");

    expect(fs.existsSync(result.manifestPath)).toBe(true);
  });

  it("is deterministic: two exports produce byte-identical files", () => {
    const group = approvedGroup("G01", readyStory("Abrir carta"), "La carta se abre");

    const first = exportProjectBacklog({ projectId, outDir }, db);
    const firstBytes = new Map(
      first.files.map((file) => [file, fs.readFileSync(file, "utf8")])
    );

    exportProjectBacklog({ projectId, outDir, force: true }, db);
    for (const [file, content] of firstBytes) {
      expect(fs.readFileSync(file, "utf8")).toBe(content);
    }
    expect(group.code).toBe("G01");
  });

  it("--check passes right after an export and fails after a manual edit", () => {
    approvedGroup("G01", readyStory("Abrir carta"), "La carta se abre");
    exportProjectBacklog({ projectId, outDir }, db);

    expect(checkProjectBacklog({ projectId, outDir }, db).upToDate).toBe(true);

    const file = path.join(outDir, "groups", "G01.md");
    fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}\nManual note\n`, "utf8");

    const check = checkProjectBacklog({ projectId, outDir }, db);
    expect(check.upToDate).toBe(false);
    expect(check.differences.join(" ")).toContain("groups/G01.md");
  });

  it("refuses to overwrite a manually edited export without --force", () => {
    approvedGroup("G01", readyStory("Abrir carta"), "La carta se abre");
    exportProjectBacklog({ projectId, outDir }, db);

    const file = path.join(outDir, "decisions.md");
    fs.writeFileSync(file, "edited by hand", "utf8");

    expect(() => exportProjectBacklog({ projectId, outDir }, db)).toThrow(/modified outside RequireFlow/);

    const forced = exportProjectBacklog({ projectId, outDir, force: true }, db);
    expect(forced.verified).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("D001");
  });

  it("--check reports a stale export when the database moved", () => {
    approvedGroup("G01", readyStory("Abrir carta"), "La carta se abre");
    exportProjectBacklog({ projectId, outDir }, db);

    const story = readyStory("Reclamar carta");
    createIncrement({ projectId, code: "G02", goal: "Reclamar" }, db);
    const g02 = db.query("SELECT id FROM increments WHERE code = 'G02'").get() as { id: string };
    addStoryToIncrement(g02.id, story.id, "user:test", db);

    // Force the status forward so the export content changes.
    updateIncrement(
      g02.id,
      (db.query("SELECT version v FROM increments WHERE id = ?").get(g02.id) as { v: number }).v,
      { status: "en_refinamiento" },
      HUMAN,
      db
    );

    const check = checkProjectBacklog({ projectId, outDir }, db);
    expect(check.upToDate).toBe(false);
    expect(check.differences.length).toBeGreaterThan(0);
  });

  it("exports a rejected group without pretending it was accepted", () => {
    const story = readyStory("Abrir carta");
    const group = approvedGroup("G01", story, "La carta se abre");
    startImplementation(group.id, ODD, db);
    submitImplementationEvidence({ incrementId: group.id, actor: ODD, evidence: "ok" }, db);
    reportDefect({ incrementId: group.id, actor: HUMAN, description: "Falla" }, db);

    exportProjectBacklog({ projectId, outDir }, db);
    const groupFile = fs.readFileSync(path.join(outDir, "groups", "G01.md"), "utf8");

    expect(groupFile).toContain("`en_correcciones`");
    expect(groupFile).not.toContain("`aceptado`");
  });
});
