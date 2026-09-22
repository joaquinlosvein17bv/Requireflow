import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { createMcpServer } from "../src/mcp/server.ts";

describe("MCP Server & Tools", () => {
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

  it("should register all 10 core tools and their aliases", () => {
    const requiredTools = [
      "rf_project_detect",
      "rf_task_list",
      "rf_task_next",
      "rf_task_add",
      "rf_task_start",
      "rf_task_complete",
      "rf_task_update",
      "rf_archive_run",
      "rf_history_search",
      "rf_efficiency_stats",
    ];

    for (const name of requiredTools) {
      expect(tools[name]).toBeDefined();
    }

    // Verify aliases
    expect(tools["project_current"]).toBeDefined();
    expect(tools["task_list"]).toBeDefined();
    expect(tools["task_next"]).toBeDefined();
    expect(tools["task_create"]).toBeDefined();
    expect(tools["task_start"]).toBeDefined();
    expect(tools["task_complete"]).toBeDefined();
    expect(tools["task_update"]).toBeDefined();
    expect(tools["task_archive_done"]).toBeDefined();
    expect(tools["history_list"]).toBeDefined();
    expect(tools["efficiency_stats"]).toBeDefined();
  });

  it("should execute task lifecycle via MCP tools", async () => {
    // 1. Detect project
    const detectRes = await tools["rf_project_detect"].handler({});
    const project = JSON.parse(detectRes.content[0].text);
    expect(project.id).toBeDefined();

    // 2. Add high priority bugfix and medium task
    const addRes1 = await tools["rf_task_add"].handler({
      projectId: project.id,
      title: "Fix memory leak",
      type: "fix",
      priority: "high",
    });
    const task1 = JSON.parse(addRes1.content[0].text);
    expect(task1.title).toBe("Fix memory leak");
    expect(task1.status).toBe("todo");

    const addRes2 = await tools["rf_task_add"].handler({
      projectId: project.id,
      title: "Add dark mode toggle",
      type: "feature",
      priority: "medium",
    });
    const task2 = JSON.parse(addRes2.content[0].text);

    // 3. Next task should be the high priority bugfix
    const nextRes = await tools["rf_task_next"].handler({ projectId: project.id });
    const nextTask = JSON.parse(nextRes.content[0].text);
    expect(nextTask.id).toBe(task1.id);
    expect(nextTask.title).toBe("Fix memory leak");

    // 4. Start task
    const startRes = await tools["rf_task_start"].handler({ id: task1.id });
    const startedTask = JSON.parse(startRes.content[0].text);
    expect(startedTask.status).toBe("in_progress");
    expect(startedTask.started_at).not.toBeNull();

    // 5. Complete task
    const completeRes = await tools["rf_task_complete"].handler({
      id: task1.id,
      notes: "Fixed circular ref in cache listener",
    });
    const completedTask = JSON.parse(completeRes.content[0].text);
    expect(completedTask.status).toBe("done");
    expect(completedTask.notes).toBe("Fixed circular ref in cache listener");

    // 6. List tasks
    const listRes = await tools["rf_task_list"].handler({ projectId: project.id });
    const allTasks = JSON.parse(listRes.content[0].text);
    expect(allTasks.length).toBe(2);

    // 7. Archive run
    const archiveRes = await tools["rf_archive_run"].handler({
      projectId: project.id,
      forceManual: true,
    });
    const archiveData = JSON.parse(archiveRes.content[0].text);
    expect(archiveData.archivedCount).toBe(1);
    expect(archiveData.taskIds).toContain(task1.id);

    // 8. History search
    const historyRes = await tools["rf_history_search"].handler({
      projectId: project.id,
      query: "circular",
    });
    const historyItems = JSON.parse(historyRes.content[0].text);
    expect(historyItems.length).toBe(1);
    expect(historyItems[0].title).toBe("Fix memory leak");

    // 9. Efficiency stats
    const statsRes = await tools["rf_efficiency_stats"].handler({ projectId: project.id });
    const stats = JSON.parse(statsRes.content[0].text);
    expect(stats.totalCompleted).toBe(1);
    expect(stats.throughput.allTime).toBe(1);
  });

  it("should return error response if task not found", async () => {
    const errorRes = await tools["rf_task_start"].handler({ id: "invalid-id" });
    expect(errorRes.isError).toBe(true);
    expect(errorRes.content[0].text).toContain("Task not found");
  });
});
