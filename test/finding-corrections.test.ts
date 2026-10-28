import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../src/db/connection.ts";
import { createHttpServer } from "../src/server/http.ts";
import { createProject } from "../src/domain/project.ts";
import { createWorkItem, updateWorkItem } from "../src/domain/backlog/work-item.ts";
import {
  addAcceptanceCriterion,
} from "../src/domain/backlog/criteria.ts";
import {
  addStoryToIncrement,
  approveIncrement,
  createIncrement,
  getIncrement,
  updateIncrement,
} from "../src/domain/backlog/increment.ts";
import {
  acceptIncrement,
  deliverCorrection,
  getIncrementReviews,
  rejectCorrection,
  reportDefect,
  startImplementation,
  submitImplementationEvidence,
  type FindingWithTracking,
} from "../src/domain/backlog/review.ts";
import { PlanValidationError } from "../src/domain/backlog/scope.ts";

const HUMAN = "human:cli";
const AGENT = "agent:odd";

describe("Finding correction tracking (option A)", () => {
  let db: Database;
  let projectId: string;
  let groupId: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    projectId = createProject({ name: "Cartas", mode: "product" }, db).id;
    const epic = createWorkItem({ projectId, kind: "epic", title: "Cartas" }, db);
    let story = createWorkItem(
      { projectId, kind: "story", title: "Abrir carta", description: "Comportamiento confirmado", parentId: epic.id },
      db
    );
    story = updateWorkItem(story.id, story.version, { status: "refined" }, "user:test", db);
    story = updateWorkItem(story.id, story.version, { status: "ready" }, "user:test", db);

    let group = createIncrement({ projectId, code: "G01", goal: "Objetivo del grupo" }, db);
    addStoryToIncrement(group.id, story.id, "user:test", db);
    addAcceptanceCriterion({ incrementId: group.id, text: "Criterio observable", actor: "user:test" }, db);
    group = updateIncrement(group.id, group.version, { status: "en_refinamiento" }, "user:test", db);
    group = updateIncrement(group.id, group.version, { status: "listo_para_aprobacion" }, "user:test", db);
    group = approveIncrement(group.id, { expectedVersion: group.version, actor: HUMAN }, db);
    startImplementation(group.id, AGENT, db);
    submitImplementationEvidence({ incrementId: group.id, actor: AGENT, evidence: "Implementación lista" }, db);
    groupId = group.id;
  });

  afterEach(() => {
    db.close();
  });

  function report(description: string) {
    return reportDefect({ incrementId: groupId, actor: HUMAN, description }, db).finding;
  }

  function correct(evidence: string, findingIds?: string[]) {
    return deliverCorrection({ incrementId: groupId, actor: AGENT, evidence, findingIds }, db);
  }

  function trackingOf(findingId: string): FindingWithTracking {
    const all = getIncrementReviews(groupId, db).flatMap((review) => review.findings);
    const found = all.find((finding) => finding.id === findingId);
    if (!found) throw new Error(`Finding ${findingId} not found`);
    return found;
  }

  it("keeps a finding pending when the correction names no findings", () => {
    const finding = report("El sobre no se abre");

    correct("Arreglo sin asociación explícita");

    expect(trackingOf(finding.id).tracking).toBe("pending");
    expect(trackingOf(finding.id).status).toBe("open");
    expect(trackingOf(finding.id).corrections).toHaveLength(0);
  });

  it("marks only the finding named by a partial correction", () => {
    const first = report("El sobre no se abre");
    correct("Arreglo del sobre", [first.id]);
    const second = report("El enlace no se comparte");

    // The second correction only addresses the first finding again; the second
    // defect stays pending instead of being assumed fixed.
    correct("Segundo arreglo del sobre", [first.id]);

    expect(trackingOf(first.id).tracking).toBe("correction_delivered");
    expect(trackingOf(second.id).tracking).toBe("pending");
    expect(trackingOf(second.id).corrections).toHaveLength(0);
  });

  it("returns the finding to pending when the human rejects its correction and keeps history", () => {
    const finding = report("El sobre no se abre");
    correct("Primer intento", [finding.id]);
    expect(trackingOf(finding.id).tracking).toBe("correction_delivered");

    rejectCorrection({
      incrementId: groupId,
      actor: HUMAN,
      findingIds: [finding.id],
      reason: "Sigue sin abrirse con el mouse",
    }, db);

    const after = trackingOf(finding.id);
    expect(after.tracking).toBe("pending");
    expect(after.status).toBe("open");
    expect(after.corrections).toHaveLength(1);
    expect(after.corrections[0]!.status).toBe("rejected");
    expect(after.corrections[0]!.rejected_reason).toBe("Sigue sin abrirse con el mouse");
    expect(getIncrement(groupId, db)!.status).toBe("en_correcciones");

    // A new attempt is appended, never replacing the rejected one.
    correct("Segundo intento", [finding.id]);
    const retried = trackingOf(finding.id);
    expect(retried.tracking).toBe("correction_delivered");
    expect(retried.corrections).toHaveLength(2);
    expect(retried.corrections.map((entry) => entry.status)).toEqual(["rejected", "delivered"]);
  });

  it("resolves findings only on human acceptance and preserves the attempts", () => {
    const first = report("El sobre no se abre");
    correct("Arreglo del sobre", [first.id]);
    const second = report("El enlace no se comparte");
    correct("Arreglo de ambos", [first.id, second.id]);

    expect(trackingOf(first.id).tracking).toBe("correction_delivered");
    expect(trackingOf(second.id).tracking).toBe("correction_delivered");

    const current = getIncrement(groupId, db)!;
    acceptIncrement({ incrementId: groupId, actor: HUMAN, expectedVersion: current.version }, db);

    const acceptedFirst = trackingOf(first.id);
    expect(acceptedFirst.tracking).toBe("resolved");
    expect(acceptedFirst.status).toBe("resolved");
    expect(acceptedFirst.corrections.length).toBeGreaterThanOrEqual(2);
    expect(acceptedFirst.corrections.at(-1)!.status).toBe("delivered");
    expect(trackingOf(second.id).tracking).toBe("resolved");
  });

  it("refuses to associate a correction with an unknown or foreign finding", () => {
    report("Defecto real");

    expect(() => correct("Intento con id inventado", ["no-existe"])).toThrow(PlanValidationError);

    const otherProject = createProject({ name: "Otro", mode: "product" }, db).id;
    const otherEpic = createWorkItem({ projectId: otherProject, kind: "epic", title: "Otra" }, db);
    let otherStory = createWorkItem(
      { projectId: otherProject, kind: "story", title: "Otra historia", description: "Confirmada", parentId: otherEpic.id },
      db
    );
    otherStory = updateWorkItem(otherStory.id, otherStory.version, { status: "refined" }, "user:test", db);
    otherStory = updateWorkItem(otherStory.id, otherStory.version, { status: "ready" }, "user:test", db);
    let otherGroup = createIncrement({ projectId: otherProject, code: "G01", goal: "Otro objetivo" }, db);
    addStoryToIncrement(otherGroup.id, otherStory.id, "user:test", db);
    addAcceptanceCriterion({ incrementId: otherGroup.id, text: "Otro criterio", actor: "user:test" }, db);
    otherGroup = updateIncrement(otherGroup.id, otherGroup.version, { status: "en_refinamiento" }, "user:test", db);
    otherGroup = updateIncrement(otherGroup.id, otherGroup.version, { status: "listo_para_aprobacion" }, "user:test", db);
    otherGroup = approveIncrement(otherGroup.id, { expectedVersion: otherGroup.version, actor: HUMAN }, db);
    startImplementation(otherGroup.id, AGENT, db);
    submitImplementationEvidence({ incrementId: otherGroup.id, actor: AGENT, evidence: "ok" }, db);
    const foreign = reportDefect(
      { incrementId: otherGroup.id, actor: HUMAN, description: "Defecto ajeno" },
      db
    ).finding;

    expect(() => correct("Intento cruzado", [foreign.id])).toThrow(PlanValidationError);
    const foreignFindings = getIncrementReviews(otherGroup.id, db).flatMap((review) => review.findings);
    expect(foreignFindings.find((finding) => finding.id === foreign.id)?.corrections).toHaveLength(0);
  });

  it("refuses to reject a finding that has no delivered correction in the pending review", () => {
    const finding = report("El sobre no se abre");
    correct("Corrección sin asociación explícita");

    expect(() =>
      rejectCorrection({
        incrementId: groupId,
        actor: HUMAN,
        findingIds: [finding.id],
        reason: "No hay corrección que rechazar",
      }, db)
    ).toThrow(PlanValidationError);
    expect(getIncrement(groupId, db)!.status).toBe("pendiente_revision_humana");
    expect(trackingOf(finding.id).tracking).toBe("pending");
  });

  it("exposes the tracking through the HTTP API and rejects through the dedicated route", async () => {
    const finding = report("El sobre no se abre");
    const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-findings-ui-"));
    fs.writeFileSync(path.join(uiDir, "index.html"), "<h1>UI</h1>");
    const server = createHttpServer({
      port: 0,
      host: "127.0.0.1",
      db,
      uiDir,
      token: "test-token",
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const headers = { "Content-Type": "application/json", "X-RequireFlow-Token": "test-token" };

    try {
      const correction = await fetch(`${baseUrl}/api/groups/${groupId}/corrections`, {
        method: "POST",
        headers,
        body: JSON.stringify({ evidence: "arreglado", findingIds: [finding.id] }),
      });
      expect(correction.status).toBe(200);

      const detail = (await (await fetch(`${baseUrl}/api/groups/${groupId}`)).json()) as {
        reviews: Array<{ findings: FindingWithTracking[] }>;
      };
      const delivered = detail.reviews.flatMap((review) => review.findings).find((entry) => entry.id === finding.id);
      expect(delivered?.tracking).toBe("correction_delivered");

      const rejection = await fetch(`${baseUrl}/api/groups/${groupId}/reject-correction`, {
        method: "POST",
        headers,
        body: JSON.stringify({ findingIds: [finding.id], reason: "Sigue fallando" }),
      });
      expect(rejection.status).toBe(200);

      const after = (await (await fetch(`${baseUrl}/api/groups/${groupId}`)).json()) as {
        reviews: Array<{ findings: FindingWithTracking[] }>;
      };
      const pending = after.reviews.flatMap((review) => review.findings).find((entry) => entry.id === finding.id);
      expect(pending?.tracking).toBe("pending");
      expect(pending?.corrections.at(-1)?.status).toBe("rejected");
      expect(pending?.corrections.at(-1)?.rejected_reason).toBe("Sigue fallando");
    } finally {
      server.stop();
      fs.rmSync(uiDir, { recursive: true, force: true });
    }
  });
});
