import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { createMcpServer } from "../src/mcp/server.ts";

describe("MCP product backlog tools", () => {
  let db: Database;
  let server: any;
  let tools: Record<string, any>;

  beforeEach(() => {
    db = createDatabase(":memory:");
    server = createMcpServer(db);
    tools = (server as any)._registeredTools;
  });

  afterEach(() => {
    db.close();
  });

  it("registers the planning tools and their aliases", () => {
    for (const name of [
      "rf_workspace_classify",
      "rf_project_set_mode",
      "rf_idea_capture",
      "rf_backlog_tree",
    ]) {
      expect(tools[name]).toBeDefined();
    }

    for (const alias of [
      "workspace_classify",
      "project_set_mode",
      "idea_capture",
      "backlog_tree",
    ]) {
      expect(tools[alias]).toBeDefined();
    }
  });

  it("captures an idea without creating an executable task", async () => {
    const project = JSON.parse(
      (await tools["rf_project_add"].handler({ name: "mcp-cards" })).content[0].text
    );

    const captured = JSON.parse(
      (
        await tools["rf_idea_capture"].handler({
          projectId: project.id,
          text: "Compartir una carta por link",
        })
      ).content[0].text
    );

    expect(captured.item.kind).toBe("idea");
    expect(captured.item.status).toBe("captured");
    expect(captured.duplicate_of).toBeNull();

    const tasks = db
      .query("SELECT COUNT(*) c FROM tasks WHERE project_id = ?")
      .get(project.id) as { c: number };
    expect(Number(tasks.c)).toBe(0);

    const tree = JSON.parse(
      (await tools["rf_backlog_tree"].handler({ projectId: project.id })).content[0].text
    );
    expect(tree.ideas).toHaveLength(1);
  });

  it("switches the project mode", async () => {
    const project = JSON.parse(
      (await tools["rf_project_add"].handler({ name: "mcp-mode" })).content[0].text
    );

    const updated = JSON.parse(
      (
        await tools["rf_project_set_mode"].handler({
          projectId: project.id,
          mode: "product",
        })
      ).content[0].text
    );

    expect(updated.mode).toBe("product");
  });

  it("exposes no tool that approves or accepts in the human's name", () => {
    const privileged = Object.keys(tools).filter((name) => /approve|accept|sign.?off/i.test(name));
    expect(privileged).toEqual([]);
  });

  it("lets an agent read a group's canonical scope directly from RequireFlow", async () => {
    const project = JSON.parse(
      (await tools["rf_project_add"].handler({ name: "mcp-groups" })).content[0].text
    );
    await tools["rf_project_set_mode"].handler({ projectId: project.id, mode: "product" });

    const epic = JSON.parse(
      (
        await tools["rf_work_item_create"].handler({
          projectId: project.id,
          kind: "epic",
          title: "Crear cartas",
        })
      ).content[0].text
    );

    let story = JSON.parse(
      (
        await tools["rf_work_item_create"].handler({
          projectId: project.id,
          kind: "story",
          title: "Abrir carta",
          description: "Abrir la carta elegida con la imagen visible",
          parentId: epic.id,
        })
      ).content[0].text
    );
    story = JSON.parse(
      (
        await tools["rf_work_item_update"].handler({
          id: story.id,
          expectedVersion: story.version,
          status: "refined",
        })
      ).content[0].text
    );
    story = JSON.parse(
      (
        await tools["rf_work_item_update"].handler({
          id: story.id,
          expectedVersion: story.version,
          status: "ready",
        })
      ).content[0].text
    );

    await tools["rf_group_propose"].handler({
      projectId: project.id,
      groups: [
        {
          code: "G01",
          goal: "El receptor abre la carta compartida",
          storyIds: [story.id],
          acceptanceCriteria: ["La carta se abre con la imagen visible"],
        },
      ],
    });

    let view = JSON.parse(
      (await tools["rf_group_get"].handler({ projectId: project.id, group: "G01" })).content[0]
        .text
    );
    expect(view.readiness.ready).toBe(true);
    expect(view.canExecute).toBe(false);

    let group = view.increment;
    for (const status of ["en_refinamiento", "listo_para_aprobacion"]) {
      group = JSON.parse(
        (
          await tools["rf_group_refine"].handler({
            projectId: project.id,
            group: "G01",
            expectedVersion: group.version,
            status,
          })
        ).content[0].text
      );
    }

    view = JSON.parse(
      (await tools["rf_group_get"].handler({ projectId: project.id, group: "G01" })).content[0]
        .text
    );
    expect(view.increment.status).toBe("listo_para_aprobacion");
    expect(view.nextAction).toBe("request_approval");
    expect(view.canExecute).toBe(false);

    const next = JSON.parse(
      (await tools["rf_group_next"].handler({ projectId: project.id })).content[0].text
    );
    expect(next.group.increment.code).toBe("G01");
  });
});
