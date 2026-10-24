import { Database } from "bun:sqlite";
import { getDatabase } from "../db/connection.ts";
import { resolveCurrentProject } from "../domain/project.ts";
import { listSections } from "../domain/section.ts";
import {
  createTask,
  listTasks,
  getNextTask,
  startTask,
  completeTask,
} from "../domain/task.ts";
import { archiveDoneTasks } from "../domain/archive.ts";
import { calculateProjectMetrics, formatDuration } from "../domain/efficiency.ts";
import { flagToBoolean, flagToNumber } from "./flags.ts";
import { startHttpServer } from "../server/http.ts";
import { startMcpServer } from "../mcp/server.ts";
import { isTaskType, isTaskPriority, TASK_TYPES, TASK_PRIORITIES } from "../domain/task.ts";

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Reports a user-facing error and marks the process as failed. */
function fail(message: string): void {
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}

export function parseArgs(rawArgs: string[]): ParsedArgs {
  const args = rawArgs.slice(2); // Skip bun and script path
  let command = "help";
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 0;
  const first = args[0];
  if (first !== undefined && !first.startsWith("-")) {
    command = first;
    i = 1;
  }

  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) {
      break;
    }

    const isLong = arg.startsWith("--");
    const isShort = !isLong && arg.startsWith("-");

    if (isLong || isShort) {
      const raw = isLong ? arg.slice(2) : arg.slice(1);
      const separator = raw.indexOf("=");

      if (separator > 0) {
        flags[raw.slice(0, separator)] = raw.slice(separator + 1);
        i += 1;
        continue;
      }

      const next = args[i + 1];
      // A negative number is a value, not the start of another flag.
      const nextIsValue =
        next !== undefined && (!next.startsWith("-") || /^-\d+(\.\d+)?$/.test(next));

      if (nextIsValue) {
        flags[raw] = next;
        i += 2;
      } else {
        flags[raw] = true;
        i += 1;
      }
    } else {
      positionals.push(arg);
      i += 1;
    }
  }

  return { command, positionals, flags };
}

export async function runCli(argv: string[] = process.argv, db: Database = getDatabase()) {
  const { command, positionals, flags } = parseArgs(argv);

  try {
    switch (command.toLowerCase()) {
    case "init": {
      const project = resolveCurrentProject(process.cwd(), db);
      console.log(`[RequireFlow] Project initialized: "${project.name}" (ID: ${project.id})`);
      console.log(`Root Path: ${project.root_path || process.cwd()}`);
      break;
    }

    case "status": {
      const project = resolveCurrentProject(process.cwd(), db);
      const tasks = listTasks(project.id, { excludeArchived: true }, db);

      console.log(`\n=== RequireFlow Status: ${project.name} ===`);
      if (tasks.length === 0) {
        console.log("No active tasks in board. Use 'requireflow add <title>' to create one.\n");
        return;
      }

      const todo = tasks.filter((t) => t.status === "todo");
      const inProgress = tasks.filter((t) => t.status === "in_progress");
      const done = tasks.filter((t) => t.status === "done");

      console.log(`\n📋 Por Hacer (${todo.length}):`);
      for (const t of todo) {
        console.log(`  [${t.priority.toUpperCase()}] [${t.type}] ${t.id.slice(0, 8)} - ${t.title}`);
      }

      console.log(`\n⚡ En Progreso (${inProgress.length}):`);
      for (const t of inProgress) {
        console.log(`  [${t.priority.toUpperCase()}] [${t.type}] ${t.id.slice(0, 8)} - ${t.title}`);
      }

      console.log(`\n✅ Completadas Recientes (${done.length}):`);
      for (const t of done) {
        console.log(`  [${t.type}] ${t.id.slice(0, 8)} - ${t.title}`);
      }
      console.log("");
      break;
    }

    case "add": {
      const title = positionals[0] || (flags["title"] as string);
      if (!title) {
        fail('Task title is required. Usage: requireflow add "Task Title" [-t type] [-p priority]');
        return;
      }

      const typeArg = String(flags["t"] || flags["type"] || "feature");
      if (!isTaskType(typeArg)) {
        fail(`Invalid type "${typeArg}". Allowed: ${TASK_TYPES.join(", ")}.`);
        return;
      }

      const priorityArg = String(flags["p"] || flags["priority"] || "medium");
      if (!isTaskPriority(priorityArg)) {
        fail(`Invalid priority "${priorityArg}". Allowed: ${TASK_PRIORITIES.join(", ")}.`);
        return;
      }

      const project = resolveCurrentProject(process.cwd(), db);
      const type = typeArg;
      const priority = priorityArg;
      const desc = (flags["d"] || flags["desc"] || flags["description"]) as string | undefined;
      const sectionArg = (flags["s"] || flags["section"]) as string | undefined;

      let sectionId: string | undefined = undefined;
      if (sectionArg) {
        const sections = listSections(project.id, db);
        const matched = sections.find(
          (s) => s.id === sectionArg || s.name.toLowerCase() === sectionArg.toLowerCase()
        );
        if (matched) sectionId = matched.id;
        else {
          fail(
            `Unknown section "${sectionArg}". Available: ${sections.map((s) => s.name).join(", ")}.`
          );
          return;
        }
      }

      const task = createTask(
        {
          projectId: project.id,
          title,
          description: desc,
          type,
          priority,
          sectionId,
        },
        db
      );

      if (flags["json"]) {
        console.log(JSON.stringify(task, null, 2));
      } else {
        console.log(`✓ Task created: [${task.id.slice(0, 8)}] "${task.title}" (${task.priority} ${task.type})`);
      }
      break;
    }

    case "next": {
      const project = resolveCurrentProject(process.cwd(), db);
      const sectionArg = (flags["s"] || flags["section"]) as string | undefined;
      let sectionId: string | undefined = undefined;

      if (sectionArg) {
        const sections = listSections(project.id, db);
        const matched = sections.find(
          (s) => s.id === sectionArg || s.name.toLowerCase() === sectionArg.toLowerCase()
        );
        if (matched) sectionId = matched.id;
      }

      const nextTask = getNextTask(project.id, sectionId, db);

      if (!nextTask) {
        if (flags["json"]) {
          console.log(JSON.stringify({ nextTask: null }));
        } else {
          console.log("No pending tasks found in To Do for project:", project.name);
        }
        return;
      }

      if (flags["json"]) {
        console.log(JSON.stringify(nextTask, null, 2));
      } else {
        console.log(`\n🎯 Next Task to Execute:`);
        console.log(`ID:          ${nextTask.id}`);
        console.log(`Title:       ${nextTask.title}`);
        console.log(`Priority:    ${nextTask.priority.toUpperCase()}`);
        console.log(`Type:        ${nextTask.type}`);
        if (nextTask.section_name) console.log(`Section:     ${nextTask.section_name}`);
        if (nextTask.description) console.log(`Description: ${nextTask.description}`);
        console.log("");
      }
      break;
    }

    case "start": {
      const taskIdArg = positionals[0];
      if (!taskIdArg) {
        fail("Task ID required. Usage: requireflow start <task-id>");
        return;
      }

      const project = resolveCurrentProject(process.cwd(), db);
      const tasks = listTasks(project.id, { excludeArchived: false }, db);
      const matched = tasks.find((t) => t.id === taskIdArg || t.id.startsWith(taskIdArg));

      if (!matched) {
        fail(`Task not found with ID starting with: ${taskIdArg}`);
        return;
      }

      const started = startTask(matched.id, db);
      console.log(`✓ Task started: "${started?.title}" (Status: in_progress)`);
      break;
    }

    case "done": {
      const taskIdArg = positionals[0];
      if (!taskIdArg) {
        fail("Task ID required. Usage: requireflow done <task-id> [-m notes]");
        return;
      }

      const project = resolveCurrentProject(process.cwd(), db);
      const tasks = listTasks(project.id, { excludeArchived: false }, db);
      const matched = tasks.find((t) => t.id === taskIdArg || t.id.startsWith(taskIdArg));

      if (!matched) {
        fail(`Task not found with ID starting with: ${taskIdArg}`);
        return;
      }

      const notes = (flags["m"] || flags["notes"] || flags["summary"]) as string | undefined;
      const completed = completeTask(matched.id, notes, db);
      const durationStr = completed?.cycle_time_seconds ? formatDuration(completed.cycle_time_seconds) : "0s";

      console.log(`✓ Task completed: "${completed?.title}"`);
      console.log(`Cycle Time: ${durationStr}`);
      if (notes) console.log(`Resolution Notes: ${notes}`);
      break;
    }

    case "archive": {
      const project = resolveCurrentProject(process.cwd(), db);
      const force = flagToBoolean(flags["force"], false);
      const threshold = flagToNumber(flags["threshold"] ?? flags["hours"], {
        min: 0,
        label: "--threshold (hours)",
      });

      const result = archiveDoneTasks(project.id, force, threshold, db);
      console.log(`📦 Archived ${result.archivedCount} task(s) from 'Done' to permanent History for "${project.name}".`);
      if (!force && result.archivedCount === 0) {
        console.log("   (Tasks stay on the board until they reach the project's archive threshold. Use --force to flush now.)");
      }
      break;
    }

    case "ui": {
      const port = flagToNumber(flags["port"], { min: 1, max: 65535, label: "--port" });
      const hostFlag = flags["host"];
      if (typeof hostFlag === "string" && hostFlag.trim() === "") {
        fail("Invalid --host: expected a hostname.");
        return;
      }
      const host = typeof hostFlag === "string" ? hostFlag.trim() : undefined;

      const server = await startHttpServer({ port, host, db });
      console.log(`Dashboard open at: http://${server.hostname}:${server.port}`);
      break;
    }

    case "mcp": {
      await startMcpServer(db);
      break;
    }

    case "stats": {
      const days = flagToNumber(flags["days"], { min: 1, max: 3650, label: "--days" }) ?? 30;
      const project = resolveCurrentProject(process.cwd(), db);
      const metrics = calculateProjectMetrics(project.id, days, db);

      console.log(`\n=== Efficiency Metrics: ${project.name} (Last ${days} Days) ===`);
      console.log(`Total Completed Tasks:  ${metrics.totalCompleted}`);
      console.log(`Active Remaining Tasks: ${metrics.totalActive}`);
      console.log(`Avg Cycle Time:         ${metrics.formattedAvgCycleTime}`);
      console.log(`Avg Lead Time:          ${metrics.formattedAvgLeadTime}`);
      console.log(`Bugfix Velocity:        ${metrics.formattedBugfixVelocity}`);
      console.log(`Throughput Today:       ${metrics.throughput.today}`);
      console.log(`Throughput This Week:   ${metrics.throughput.thisWeek}`);
      console.log(
        `Distribution:           Features: ${metrics.distribution.feature} | Bugfixes: ${metrics.distribution.bugfix} | Chores: ${metrics.distribution.chore} | Refactors: ${metrics.distribution.refactor}\n`
      );
      break;
    }

    case "help": {
      printHelp();
      break;
    }

    default: {
      fail(`Unknown command "${command}". Run 'requireflow help' to see the available commands.`);
      break;
    }
  }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

function printHelp(): void {
  console.log(`
RequireFlow — Local-First Task & Lifecycle Engine for Developers & AI Agents

USAGE:
  requireflow <command> [arguments] [flags]

COMMANDS:
  init                  Link or initialize current directory as active project
  status                Show active Kanban status (To Do, In Progress, Done)
  add "<title>"         Add a task to backlog (-t type, -p priority, -s section)
  next                  Get the highest priority pending task to work on
  start <id>            Start working on a task (records started_at)
  done <id>             Mark a task as completed (records completed_at, computes cycle time)
  archive [--force]     Flush completed tasks from board to permanent history
  ui [--port 4242]      Launch embedded Web UI dashboard
  mcp                   Start stdio Model Context Protocol (MCP) server
  stats                 Show cycle time, throughput, and bugfix velocity metrics
  help                  Show this help message

FLAGS:
  -t, --type <type>         Task type: feature, fix, bugfix, chore, refactor, debt
  -p, --priority <priority> Priority: low, medium, high, blocker
  -s, --section <section>   Section name or ID
  -m, --notes <notes>       Resolution summary notes
  --json                    Output in JSON format
  --port <port>             HTTP Server port (default: 4242)
  --days <n>                Window for stats (default: 30)
  --threshold <hours>       Archive age threshold; --force flushes immediately
`);
}

if (import.meta.main) {
  runCli().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
