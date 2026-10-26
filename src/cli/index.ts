import { Database } from "bun:sqlite";
import path from "node:path";
import {
  getDatabase,
  resolveDbPath,
  inspectDatabase,
  legacyDbPath,
  v2DbPath,
  V2_SCHEMA_VERSION,
  LegacyDatabaseError,
} from "../db/connection.ts";
import { exportLegacyDatabase } from "../domain/legacy/export.ts";
import {
  resolveCurrentProject,
  setProjectMode,
  isProjectMode,
  classifyWorkspace,
} from "../domain/project.ts";
import { listSections } from "../domain/section.ts";
import { createIdea, getBacklogTree } from "../domain/backlog/work-item.ts";
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
      const classification = classifyWorkspace(process.cwd(), db);
      if (classification.situation === "ambiguous") {
        fail(
          `Refusing to initialise a project in a generic location. ${classification.reason} Run it inside the product directory instead.`
        );
        return;
      }

      const project = resolveCurrentProject(process.cwd(), db);
      const requestedMode = flags["mode"];
      if (requestedMode !== undefined) {
        if (!isProjectMode(requestedMode)) {
          fail(`Invalid mode "${String(requestedMode)}". Allowed: legacy, product.`);
          return;
        }
        const updated = setProjectMode(project.id, requestedMode, "user:cli", db);
        if (updated) {
          console.log(
            `[RequireFlow] Project initialized: "${updated.name}" (ID: ${updated.id})`
          );
          console.log(`Root Path: ${updated.root_path || process.cwd()}`);
          console.log(`Mode: ${updated.mode}`);
          console.log(`Situation: ${classification.situation}`);
          break;
        }
      }
      console.log(`[RequireFlow] Project initialized: "${project.name}" (ID: ${project.id})`);
      console.log(`Root Path: ${project.root_path || process.cwd()}`);
      console.log(`Mode: ${project.mode}`);
      console.log(`Situation: ${classification.situation}`);
      break;
    }

    case "mode": {
      const project = resolveCurrentProject(process.cwd(), db);
      const requested = positionals[0];

      if (requested === undefined) {
        console.log(`Project "${project.name}" mode: ${project.mode}`);
        break;
      }

      if (!isProjectMode(requested)) {
        fail(`Invalid mode "${requested}". Allowed: legacy, product.`);
        return;
      }

      const updated = setProjectMode(project.id, requested, "user:cli", db);
      console.log(`✓ Project "${updated?.name}" mode: ${updated?.mode}`);
      break;
    }

    case "idea":
    case "capture": {
      const text = positionals.join(" ").trim() || (flags["text"] as string | undefined);
      if (!text) {
        fail('Idea text is required. Usage: requireflow idea "texto de la idea"');
        return;
      }

      const classification = classifyWorkspace(process.cwd(), db);
      if (classification.situation === "ambiguous") {
        fail(
          `Refusing to capture an idea outside a product. ${classification.reason} Open the product directory first.`
        );
        return;
      }

      const project = resolveCurrentProject(process.cwd(), db);
      const result = createIdea(
        {
          projectId: project.id,
          text,
          operationKey: (flags["key"] as string | undefined) ?? undefined,
        },
        db
      );
      if (flags["json"]) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`✓ Idea captured: ${result.item.title}`);
        console.log(`  id: ${result.item.id}`);
        console.log(`  project: ${project.name} (${result.item.status})`);
        if (result.duplicateOf) {
          console.log(
            `  ! Similar idea already exists: "${result.duplicateOf.title}" (${result.duplicateOf.id})`
          );
        }
      }
      break;
    }

    case "backlog": {
      const project = resolveCurrentProject(process.cwd(), db);
      const tree = getBacklogTree(project.id, db);

      if (flags["json"]) {
        console.log(JSON.stringify(tree, null, 2));
        break;
      }

      console.log(`\n=== Product Backlog: ${project.name} (${project.mode}) ===`);
      console.log(`\n💡 Ideas (${tree.ideas.length}):`);
      for (const idea of tree.ideas) {
        console.log(`  [${idea.status}] ${idea.id.slice(0, 8)} - ${idea.title}`);
      }

      console.log(`\n🧩 Epics (${tree.epics.length}):`);
      for (const epic of tree.epics) {
        console.log(`  ${epic.code ?? "E??"} ${epic.title} (${epic.stories.length} stories)`);
        for (const story of epic.stories) {
          console.log(`     - ${story.code ?? "H???"} [${story.status}] ${story.title}`);
        }
      }

      if (tree.ungrouped.length > 0) {
        console.log(`\n⚠ Stories without epic (${tree.ungrouped.length}):`);
        for (const story of tree.ungrouped) {
          console.log(`  ${story.code ?? "H???"} - ${story.title}`);
        }
      }
      console.log("");
      break;
    }

    case "db": {
      const activePath = resolveDbPath();
      const inspection = inspectDatabase(activePath);
      const legacy = legacyDbPath();
      const legacyInspection = inspectDatabase(legacy);

      console.log(`\n=== RequireFlow storage ===`);
      console.log(`Active DB:      ${activePath}`);
      console.log(
        `Active schema:  ${inspection.exists ? `v${inspection.schemaVersion}` : `not created yet (will initialise to v${V2_SCHEMA_VERSION})`}`
      );
      console.log(`V2 default:     ${v2DbPath()}`);
      console.log(
        `Legacy v1 DB:   ${legacy} ${legacyInspection.exists ? `(schema v${legacyInspection.schemaVersion}, ${legacyInspection.sizeBytes} bytes, NOT migrated)` : "(not found)"}`
      );

      if (path.resolve(activePath) === path.resolve(legacy)) {
        console.log("\nWARNING: the active database is the legacy v1 file.");
      }

      if (inspection.exists && !inspection.isLegacy) {
        const db = getDatabase();
        const counts = {
          projects: Number((db.query("SELECT COUNT(*) c FROM projects").get() as { c: number }).c),
          tasks: Number((db.query("SELECT COUNT(*) c FROM tasks").get() as { c: number }).c),
          workItems: Number(
            (db.query("SELECT COUNT(*) c FROM work_items").get() as { c: number }).c
          ),
          history: Number((db.query("SELECT COUNT(*) c FROM history").get() as { c: number }).c),
        };
        console.log(
          `Contents:       ${counts.projects} projects · ${counts.tasks} tasks · ${counts.workItems} work items · ${counts.history} history rows`
        );
      }
      console.log("");
      break;
    }

    case "legacy": {
      const subcommand = positionals[0];
      if (subcommand !== "export") {
        fail(
          'Usage: requireflow legacy export [--source <db>] [--out <dir>] [--force] [--json]'
        );
        return;
      }

      const source = (flags["source"] as string | undefined) || legacyDbPath();
      const outDir = (flags["out"] as string | undefined) || path.resolve("legacy-export");
      const force = flagToBoolean(flags["force"], false);

      const result = exportLegacyDatabase({ sourcePath: source, outDir, force });

      if (flags["json"]) {
        console.log(JSON.stringify(result, null, 2));
        if (!result.verified) process.exitCode = 1;
        break;
      }

      console.log(`\n=== Legacy export ===`);
      console.log(`Source:        ${result.sourcePath}`);
      console.log(`Schema:        v${result.schemaVersion} (RequireFlow 1)`);
      console.log(`Index:         ${result.indexPath}`);
      console.log(`Structured:    ${result.jsonPath}`);
      console.log(`Per project:   ${result.projectFiles.length} file(s) in ${path.join(result.outDir, "projects")}`);
      console.log(
        `Counts:        ${result.counts.projects} projects · ${result.counts.sections} sections · ${result.counts.tasks} tasks · ${result.counts.history} history rows`
      );
      console.log(`Integrity:     ${result.integrity}`);
      console.log(`Snapshot hash: ${result.snapshotSha256}`);
      console.log(`Content hash:  ${result.contentSha256}`);
      console.log(`Verified:      ${result.verified ? "yes (snapshot rows match the export)" : "NO"}`);
      if (!result.verified) {
        console.error("Export verification failed: the written files do not match the snapshot.");
        process.exitCode = 1;
      }
      console.log("");
      break;
    }

    case "status": {
      const project = resolveCurrentProject(process.cwd(), db);
      const tasks = listTasks(project.id, { excludeArchived: true }, db);

      console.log(`\n=== RequireFlow Status: ${project.name} ===`);
      console.log(`Mode: ${project.mode}`);
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
  db                    Show the active database, its schema and the legacy v1 file
  legacy export         Archive a RequireFlow 1 database to Markdown (read-only)
  init [--mode <m>]    Link or initialize current directory as active project
  mode [legacy|product] Show or switch the project workflow mode
  status                Show active Kanban status (To Do, In Progress, Done)
  idea "<text>"         Capture a raw idea without creating executable work
  backlog               Show ideas, epics and stories for the project
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
    if (err instanceof LegacyDatabaseError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
