import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import { Database } from "bun:sqlite";
import { getDatabase } from "../db/connection.ts";
import { resolveCurrentProject, getProject, listProjects } from "../domain/project.ts";
import {
  createTask,
  getTask,
  listTasks,
  getNextTask,
  startTask,
  completeTask,
  updateTask,
  type TaskType,
  type TaskPriority,
  type TaskStatus,
} from "../domain/task.ts";
import { archiveDoneTasks } from "../domain/archive.ts";
import { searchHistory } from "../domain/history.ts";
import { calculateProjectMetrics } from "../domain/efficiency.ts";

function resolveProjectId(projectId?: string, db?: Database): string {
  if (projectId) {
    const existing = getProject(projectId, db);
    if (existing) return existing.id;
  }
  const current = resolveCurrentProject(process.cwd(), db);
  return current.id;
}

export function registerMcpTools(server: McpServer, db: Database = getDatabase()): void {
  // Helper to register tool under primary and alias name
  const registerDual = <T extends Record<string, z.ZodTypeAny>>(
    primaryName: string,
    aliasName: string,
    description: string,
    shape: T,
    handler: (args: z.infer<z.ZodObject<T>>) => Promise<any> | any
  ) => {
    const wrappedHandler = async (args: any) => {
      try {
        const result = await handler(args);
        return {
          content: [
            {
              type: "text" as const,
              text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error executing ${primaryName}: ${err?.message || String(err)}`,
            },
          ],
        };
      }
    };

    server.tool(primaryName, description, shape, wrappedHandler);
    server.tool(aliasName, `${description} (alias of ${primaryName})`, shape, wrappedHandler);
  };

  // 1. rf_project_detect / project_current
  registerDual(
    "rf_project_detect",
    "project_current",
    "Auto-resolve or detect the active project from current directory or Git root",
    {
      cwd: z.string().optional().describe("Working directory to detect project from"),
    },
    (args) => {
      const targetCwd = args.cwd || process.cwd();
      const allProjects = listProjects(db);
      const matched = allProjects.find(
        (p) => p.root_path && path.resolve(p.root_path) === path.resolve(targetCwd)
      );
      const project = resolveCurrentProject(targetCwd, db);
      return {
        ...project,
        is_directory_linked: Boolean(matched),
      };
    }
  );

  // 1b. rf_project_list / project_list
  registerDual(
    "rf_project_list",
    "project_list",
    "List all registered projects in RequireFlow with their IDs, names, root paths, and active task counts",
    {},
    () => {
      const projects = listProjects(db);
      return projects;
    }
  );

  // 2. rf_task_list / task_list
  registerDual(
    "rf_task_list",
    "task_list",
    "List tasks for a project with optional filters for status, section, priority, and type",
    {
      projectId: z.string().optional().describe("Project ID (defaults to current project)"),
      status: z
        .enum(["backlog", "todo", "in_progress", "done", "archived"])
        .optional()
        .describe("Filter by task status"),
      sectionId: z.string().optional().describe("Filter by section ID"),
      priority: z
        .enum(["low", "medium", "high", "blocker"])
        .optional()
        .describe("Filter by priority"),
      type: z
        .enum(["feature", "fix", "bugfix", "chore", "refactor", "debt"])
        .optional()
        .describe("Filter by task type"),
    },
    (args) => {
      const pId = resolveProjectId(args.projectId, db);
      const tasks = listTasks(
        pId,
        {
          status: args.status as TaskStatus | undefined,
          sectionId: args.sectionId,
          priority: args.priority as TaskPriority | undefined,
          type: args.type as TaskType | undefined,
        },
        db
      );
      return tasks;
    }
  );

  // 3. rf_task_next / task_next
  registerDual(
    "rf_task_next",
    "task_next",
    "Get the single highest-priority pending task to work on next (blocker > high > medium > low)",
    {
      projectId: z.string().optional().describe("Project ID (defaults to current project)"),
      sectionId: z.string().optional().describe("Optional section filter"),
    },
    (args) => {
      const pId = resolveProjectId(args.projectId, db);
      const task = getNextTask(pId, args.sectionId, db);
      return task || { message: "No pending tasks found in backlog/todo" };
    }
  );

  // 4. rf_task_add / task_create
  registerDual(
    "rf_task_add",
    "task_create",
    "Add a new task, feature, chore, or bugfix to the project backlog",
    {
      title: z.string().min(1).describe("Task title or headline"),
      projectId: z.string().optional().describe("Project ID (defaults to current project)"),
      description: z.string().optional().describe("Detailed description or instructions"),
      sectionId: z.string().optional().describe("Target section ID"),
      type: z
        .enum(["feature", "fix", "bugfix", "chore", "refactor", "debt"])
        .optional()
        .default("feature")
        .describe("Type of task"),
      priority: z
        .enum(["low", "medium", "high", "blocker"])
        .optional()
        .default("medium")
        .describe("Priority level"),
      storyPoints: z.number().optional().describe("Estimated story points"),
      tags: z.union([z.array(z.string()), z.string()]).optional().describe("Tags"),
    },
    (args) => {
      const pId = resolveProjectId(args.projectId, db);
      const created = createTask(
        {
          projectId: pId,
          title: args.title,
          description: args.description,
          sectionId: args.sectionId,
          type: args.type as TaskType,
          priority: args.priority as TaskPriority,
          storyPoints: args.storyPoints,
          tags: args.tags,
        },
        db
      );
      return created;
    }
  );

  // 5. rf_task_start / task_start
  registerDual(
    "rf_task_start",
    "task_start",
    "Transition a task to in_progress and record the started_at timestamp",
    {
      id: z.string().min(1).describe("Task ID to start"),
    },
    (args) => {
      const started = startTask(args.id, db);
      if (!started) {
        throw new Error(`Task not found with ID: ${args.id}`);
      }
      return started;
    }
  );

  // 6. rf_task_complete / task_complete
  registerDual(
    "rf_task_complete",
    "task_complete",
    "Mark a task as completed (done), record completed_at timestamp, calculate cycle time, and save resolution notes",
    {
      id: z.string().min(1).describe("Task ID to complete"),
      notes: z.string().optional().describe("Summary notes of the resolution or implementation"),
    },
    (args) => {
      const completed = completeTask(args.id, args.notes, db);
      if (!completed) {
        throw new Error(`Task not found with ID: ${args.id}`);
      }
      return completed;
    }
  );

  // 7. rf_task_update / task_update
  registerDual(
    "rf_task_update",
    "task_update",
    "Update task title, description, priority, type, section, or notes",
    {
      id: z.string().min(1).describe("Task ID to update"),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description"),
      priority: z.enum(["low", "medium", "high", "blocker"]).optional().describe("New priority"),
      type: z.enum(["feature", "fix", "bugfix", "chore", "refactor", "debt"]).optional().describe("New type"),
      sectionId: z.string().optional().describe("New section ID"),
      status: z.enum(["backlog", "todo", "in_progress", "done", "archived"]).optional().describe("New status"),
      notes: z.string().optional().describe("Notes"),
      tags: z.union([z.array(z.string()), z.string()]).optional().describe("Tags"),
    },
    (args) => {
      const tagsStr = Array.isArray(args.tags) ? args.tags.join(",") : args.tags;
      const updated = updateTask(
        args.id,
        {
          title: args.title,
          description: args.description,
          priority: args.priority as TaskPriority | undefined,
          type: args.type as TaskType | undefined,
          section_id: args.sectionId,
          status: args.status as TaskStatus | undefined,
          notes: args.notes,
          tags: tagsStr,
        },
        db
      );
      if (!updated) {
        throw new Error(`Task not found with ID: ${args.id}`);
      }
      return updated;
    }
  );

  // 8. rf_archive_run / task_archive_done
  registerDual(
    "rf_archive_run",
    "task_archive_done",
    "Flush all currently completed tasks from the active board into the permanent history archive",
    {
      projectId: z.string().optional().describe("Project ID (defaults to current project)"),
      forceManual: z.boolean().optional().default(true).describe("Force immediate archive flush of all done tasks"),
      thresholdHours: z.number().optional().describe("Threshold in hours if not forcing manual flush"),
    },
    (args) => {
      const pId = resolveProjectId(args.projectId, db);
      const result = archiveDoneTasks(pId, args.forceManual ?? true, args.thresholdHours, db);
      return result;
    }
  );

  // 9. rf_history_search / history_list
  registerDual(
    "rf_history_search",
    "history_list",
    "Search through permanent history archive using FTS5 full-text search across past work, resolutions, and notes",
    {
      projectId: z.string().optional().describe("Project ID (defaults to current project)"),
      query: z.string().optional().describe("Search keywords or query"),
      limit: z.number().optional().default(20).describe("Maximum records to return"),
    },
    (args) => {
      const pId = resolveProjectId(args.projectId, db);
      const items = searchHistory(pId, args.query, args.limit ?? 20, db);
      return items;
    }
  );

  // 10. rf_efficiency_stats / efficiency_stats
  registerDual(
    "rf_efficiency_stats",
    "efficiency_stats",
    "Retrieve efficiency metrics including average cycle time, lead time, throughput, and bugfix velocity",
    {
      projectId: z.string().optional().describe("Project ID (defaults to current project)"),
      timeWindowDays: z.number().optional().default(30).describe("Time window in days for metrics calculation"),
    },
    (args) => {
      const pId = resolveProjectId(args.projectId, db);
      const stats = calculateProjectMetrics(pId, args.timeWindowDays ?? 30, db);
      return stats;
    }
  );
}
