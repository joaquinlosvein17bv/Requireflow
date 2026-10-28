import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const UI_DIR = path.resolve(import.meta.dir, "..", "src", "ui");

function readIndex(): string {
  return fs.readFileSync(path.join(UI_DIR, "index.html"), "utf8");
}

function readSource(): string {
  return fs.readFileSync(path.join(UI_DIR, "app.js"), "utf8");
}

function readStyles(): string {
  return fs.readFileSync(path.join(UI_DIR, "styles.css"), "utf8");
}

describe("Supervision-first dashboard", () => {
  it("opens on the overview before the technical tabs", () => {
    const html = readIndex();

    expect(html).toContain('class="nav-item active" data-tab="overview"');
    expect(html.indexOf('data-tab="overview"')).toBeLessThan(html.indexOf('data-tab="kanban"'));
    expect(html).toContain('<section id="viewOverview" class="view-panel active">');
    expect(html).toContain('<section id="viewKanban" class="view-panel">');
  });

  it("ships the overview supervision blocks", () => {
    const html = readIndex();

    expect(html).toContain('id="overviewSummary"');
    expect(html).toContain('id="overviewStatusStrip"');
    expect(html).toContain('id="overviewGroups"');
    expect(html).toContain('id="overviewMapGroups"');
    expect(html).toContain('id="overviewMapEpics"');
    expect(html).toContain('id="btnMapByGroup"');
    expect(html).toContain('id="btnMapByEpic"');
    expect(html).toContain('id="groupFilters"');
  });

  it("keeps every previous dashboard area", () => {
    const html = readIndex();

    for (const tab of ["kanban", "ideas", "groups", "backlog", "history", "metrics", "projects"]) {
      expect(html).toContain(`data-tab="${tab}"`);
    }
    expect(html).toContain('id="viewKanban"');
    expect(html).toContain('id="viewIdeas"');
    expect(html).toContain('id="viewHistory"');
    expect(html).toContain('id="viewMetrics"');
    expect(html).toContain('id="viewProjects"');
  });

  it("renders both product perspectives from the same payloads", () => {
    const source = readSource();

    expect(source).toContain("function renderOverviewMap");
    expect(source).toContain("function buildGroupTree");
    expect(source).toContain("function buildEpicTree");
    expect(source).toContain("function groupsForStory");
    expect(source).toContain("state.planning");
  });

  it("keeps manual editing behind an explicit, optional mode", () => {
    const source = readSource();

    expect(source).toContain("editMode: false");
    expect(source).toContain("if (state.editMode) detail.append(buildEditPanel(view));");
    expect(source).toContain("function buildEditPanel");
    expect(source).toContain("expectedVersion: group.version");
    expect(source).toContain("expectedVersion: criterion.version");
    expect(source).toContain("expectedVersion: current.version");
    expect(source).toContain("No disponible en esta interfaz");
  });

  it("keeps the human gates and their typed confirmation phrases", () => {
    const source = readSource();

    expect(source).toContain("APROBAR ${group.code}");
    expect(source).toContain("ACEPTAR ${group.code}");
    expect(source).toContain("function askHumanConfirmation");
    expect(source).toContain("showToast(`Escribí exactamente: ${pendingConfirmation.expected}`, \"error\")");
  });

  it("opens the confirmation modal with the class the stylesheet actually shows", () => {
    const source = readSource();
    const styles = readStyles();

    expect(styles).toContain(".modal-backdrop.open");
    expect(source).toContain('modal?.classList.add("open")');
    expect(source).not.toContain('modal?.classList.add("active")');
  });

  it("respects the hidden attribute for the epic list and other toggleable blocks", () => {
    const styles = readStyles();

    expect(styles).toContain("[hidden] {\n  display: none !important;\n}");
  });

  it("builds group, story and criterion nodes with textContent, never injected markup", () => {
    const source = readSource();

    expect(source).not.toMatch(/innerHTML\s*=\s*[^;]*view\.increment\./);
    expect(source).not.toMatch(/innerHTML\s*=\s*[^;]*criterion\./);
    expect(source).toContain("text: criterion.text");
    expect(source).toContain("text: story.title");
  });

  it("renders the full criteria history with traceability", () => {
    const source = readSource();

    expect(source).toContain("view.acceptanceCriteriaHistory ?? view.acceptanceCriteria");
    expect(source).toContain("Sustituidos");
    expect(source).toContain("Retirados");
    expect(source).toContain("criterion.superseded_by");
  });

  it("renders finding tracking states and the human rejection control", () => {
    const source = readSource();

    expect(source).toContain("FINDING_STATE_LABELS");
    expect(source).toContain("Corrección entregada — pendiente de revisión");
    expect(source).toContain("Resuelto y aceptado");
    expect(source).toContain("reject-correction");
    expect(source).toContain("finding.corrections");
  });

  it("explains why a group cannot be executed", () => {
    const source = readSource();

    expect(source).toContain("function groupBlockReason");
    expect(source).toContain("view.readiness.blockers.join");
    expect(source).toContain("exec-pill");
  });
});
