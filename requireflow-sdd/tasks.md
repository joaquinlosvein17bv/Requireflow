# Tasks: RequireFlow Implementation Plan

This implementation checklist is designed for an autonomous AI agent or software engineer to execute sequentially using **Bun** (`bun test`, `bun run`, `bun build`).

---

## Unit 1: Environment & Project Scaffolding
- [x] **1.1 Initialize Bun Repository & Structure**
  - Run `bun init -y` in target repository.
  - Create directory layout: `src/db`, `src/domain`, `src/mcp`, `src/server`, `src/ui`, `src/cli`, `bin`, `test`.
  - Configure `package.json` with scripts:
    - `"start"`: `"bun run src/cli/index.ts"`
    - `"test"`: `"bun test"`
    - `"build"`: `"bun build --compile --minify --sourcemap ./bin/requireflow.ts --outfile dist/requireflow"`
    - `"ui:dev"`: `"bun run src/server/http.ts"`
  - Set up `tsconfig.json` with strict type checking, Bun types (`@types/bun`), and path aliases.
- [x] **1.2 Install MCP SDK & Utilities**
  - Install dependencies: `@modelcontextprotocol/sdk`, `zod` (for schema parsing).
  - Verify Bun runtime and test framework work (`bun test`).

---

## Unit 2: Local SQLite Storage & Migration Engine
- [x] **2.1 Database Connection & Configuration**
  - Create `src/db/connection.ts`:
    - Resolve path to `~/.requireflow/requireflow.db` (cross-platform home directory resolution via `os.homedir()`).
    - Support environment variable override `REQUIREFLOW_DB_PATH`.
    - Ensure parent directory `~/.requireflow/` exists with proper directory permissions (`0700`).
    - Open `bun:sqlite` database with `WAL` journal mode enabled (`PRAGMA journal_mode = WAL;`).
    - Enable foreign keys (`PRAGMA foreign_keys = ON;`) and busy timeout (`PRAGMA busy_timeout = 5000;`).
- [x] **2.2 DDL Schema & FTS5 Migration**
  - Create `src/db/schema.ts`:
    - Define DDL statements for `projects`, `sections`, `tasks`, `history`, and `config` tables.
    - Define FTS5 virtual table `history_fts` and triggers for insert/update/delete sync.
  - Create `src/db/migrations.ts`:
    - Migration runner storing applied migrations in a `_schema_migrations` table.
- [x] **2.3 Storage Layer Tests**
  - Write `test/db.test.ts`:
    - Test in-memory / temporary SQLite instance creation.
    - Verify table creation, indexes, foreign key enforcement, and FTS5 search.

---

## Unit 3: Domain Entities & Business Logic
- [x] **3.1 Project Auto-Resolution Service**
  - Create `src/domain/project.ts`:
    - `resolveCurrentProject(cwd?: string)`: Find Git root using parent directory traversal (`.git`), fallback to directory hash + basename.
    - `getOrCreateProject(name: string, rootPath: string)`: Idempotent lookup and creation.
    - `listProjects()`: List all registered projects with active task counts.
- [x] **3.2 Section Management Service**
  - Create `src/domain/section.ts`:
    - CRUD operations for sections: `createSection`, `listSections(projectId)`, `updateSection`, `deleteSection`.
    - Seed default sections for new projects: `General`, `Frontend`, `Backend`, `Bugfixes`.
- [x] **3.3 Task Lifecycle & Backlog Engine**
  - Create `src/domain/task.ts`:
    - `createTask(data)`: Supports `type: "feature" | "bugfix" | "chore" | "debt"`, `priority`, `sectionId`, optional `tags`.
    - `listTasks(projectId, filters)`: Filter by status, section, priority, type.
    - `getNextTask(projectId, sectionId?)`: Highest priority `todo` item using sort: `priority DESC`, `created_at ASC`.
    - `startTask(taskId)`: Transitions to `in_progress`, sets `started_at = CURRENT_TIMESTAMP`.
    - `completeTask(taskId, resolutionSummary?)`: Transitions to `done`, sets `completed_at = CURRENT_TIMESTAMP`.
    - `updateTask(taskId, updates)`: Modifies title, description, priority, section, tags.
- [x] **3.4 Dual Archival Engine (Automatic + Manual)**
  - Create `src/domain/archive.ts`:
    - `archiveDoneTasks(projectId?, forceManual?: boolean, thresholdHours?: number)`:
      - Read `thresholdHours` from project/system config (default: 24).
      - Select candidate tasks: `status = 'done'` AND (`forceManual === true` OR `completed_at <= now() - threshold_hours`).
      - Insert records into `history` table (recording `total_cycle_time_ms`, resolution summary, archived_at).
      - Update task status to `'archived'`.
      - Transactional batch execution using `bun:sqlite` transaction.
- [x] **3.5 History & FTS5 Search Service**
  - Create `src/domain/history.ts`:
    - `searchHistory(query, filters)`: Query `history_fts` joined with `history` and `projects`.
    - `listHistory(projectId, page, limit)`: Paginated changelog timeline sorted by `archived_at DESC`.
- [x] **3.6 Efficiency & Cycle Time Analytics Engine**
  - Create `src/domain/efficiency.ts`:
    - `calculateProjectMetrics(projectId, timeWindowDays?)`:
      - Total completed tasks, total bugfixes vs features.
      - Average Cycle Time (`completed_at - started_at`).
      - Average Lead Time (`completed_at - created_at`).
      - Bugfix resolution velocity (mean time to fix).
      - Weekly throughput trends.
- [x] **3.7 Domain Layer Tests**
  - Write `test/domain.test.ts`:
    - Test Git auto-detection.
    - Test task transitions (`todo` -> `in_progress` -> `done` -> `archived`).
    - Test manual archive flush vs automatic threshold expiration.
    - Test cycle time calculations and history FTS search.

---

## Unit 4: Model Context Protocol (MCP) Server
- [x] **4.1 MCP Protocol Stdio Server**
  - Create `src/mcp/server.ts`:
    - Initialize `@modelcontextprotocol/sdk/server/index.js` using `StdioServerTransport`.
    - Register standard tools capabilities.
- [x] **4.2 Register Core Agent Tools**
  - Create `src/mcp/tools.ts` with 10 tools:
    - `rf_project_detect`: Auto-resolve current project from cwd.
    - `rf_task_list`: List tasks for project with filters (`status`, `section`).
    - `rf_task_next`: Get single highest-priority task to work on.
    - `rf_task_add`: Add a new task or bugfix with section and tags.
    - `rf_task_start`: Mark task in-progress (timestamping started_at).
    - `rf_task_complete`: Mark task completed (timestamping completed_at).
    - `rf_task_update`: Update metadata, move sections, adjust priority.
    - `rf_archive_run`: Trigger manual archive flush from Done to History.
    - `rf_history_search`: Semantic full-text search across past work.
    - `rf_efficiency_stats`: Retrieve cycle time and throughput metrics.
- [x] **4.3 MCP End-to-End Tests**
  - Write `test/mcp.test.ts`:
    - Mock stdio request/response frames.
    - Validate JSON schema parsing, tool handlers, error code serialization.

---

## Unit 5: HTTP Server & REST API Layer
- [x] **5.1 Bun.serve() Infrastructure**
  - Create `src/server/http.ts`:
    - Configurable host (`127.0.0.1`) and port (`4242` default, `--port` flag).
    - CORS headers for local origin, JSON body parser, request logger.
    - Static file server mapping `/` to `src/ui/` with MIME type resolution.
- [x] **5.2 API Routes Implementation**
  - Create `src/server/routes.ts`:
    - `GET /api/projects` & `POST /api/projects`
    - `GET /api/projects/:id/sections` & `POST /api/projects/:id/sections`
    - `GET /api/projects/:id/tasks` & `POST /api/projects/:id/tasks`
    - `PATCH /api/tasks/:id` & `DELETE /api/tasks/:id`
    - `POST /api/tasks/:id/start` & `POST /api/tasks/:id/complete`
    - `POST /api/projects/:id/archive` (manual trigger)
    - `GET /api/projects/:id/history` (search & changelog)
    - `GET /api/projects/:id/metrics` (efficiency stats)
- [x] **5.3 HTTP Server Tests**
  - Write `test/server.test.ts`:
    - Test all REST endpoints with `fetch()` against test port.
    - Test static asset delivery and 404 handling.

---

## Unit 6: Embedded Vanilla Web UI
- [x] **6.1 HTML5 Shell & Navigation Structure**
  - Create `src/ui/index.html`:
    - Semantic HTML5 structure (Sidebar, Header, Main View Container, Modal System).
    - Tabs:
      - 📂 Projects Overview
      - 📋 Kanban Board (To Do, In Progress, Done)
      - 📝 Backlog List & Sections
      - 📜 History & Changelog (Archived Tasks)
      - ⚡ Efficiency & Metrics
- [x] **6.2 Modern CSS Styling (No Frameworks)**
  - Create `src/ui/styles.css`:
    - CSS custom properties (variables) for dark/light themes.
    - Flexbox & CSS Grid responsive layouts.
    - Kanban columns with badge chips for priorities, bugfix tags, and cycle times.
    - Clean toast notifications and modal overlay styles.
- [x] **6.3 Vanilla JavaScript Application Logic**
  - Create `src/ui/app.js`:
    - State management (selected project, active tab, active section filter).
    - REST client abstraction (`fetchAPI`).
    - Renderers:
      - `renderProjects()`: Project selector and quick stats.
      - `renderKanban()`: 3-column board with section filter chips, task action buttons ("Start", "Complete", "Edit").
      - `renderArchiveButton()`: Prominent "📦 Archivar Completadas" action with real-time counter.
      - `renderBacklog()`: Accordion list grouped by Section, drag/sort or order indicators.
      - `renderHistory()`: Search input with debounced FTS query, date range filters, expandable resolution details.
      - `renderMetrics()`: Cycle time cards, bugfix velocity gauge, lead time breakdown.

---

## Unit 7: CLI Entrypoint & Packaging
- [x] **7.1 Command Line Interface Implementation**
  - Create `src/cli/index.ts`:
    - Argument parser for subcommands:
      - `requireflow init`: Scaffold or link current directory as project.
      - `requireflow status`: Display console summary of active tasks.
      - `requireflow add "<title>" [-t type] [-p priority] [-s section]`: Create task.
      - `requireflow next`: Output next ready task (with format options for AI agents).
      - `requireflow start <task-id>`: Move to in-progress.
      - `requireflow done <task-id> [-m summary]`: Move to done.
      - `requireflow archive [--force]`: Execute archive engine.
      - `requireflow ui [--port 4242]`: Launch web dashboard and open browser.
      - `requireflow mcp`: Start stdio MCP server.
      - `requireflow stats`: Print cycle time and velocity summary.
  - Create `bin/requireflow.ts` executable shebang script.
- [x] **7.2 Single Binary Compilation & Verification**
  - Test compiling standalone executable: `bun build --compile --minify ./bin/requireflow.ts --outfile dist/requireflow`.
  - Validate binary execution without system node/bun dependencies.
  - Verify overall test suite passes (`bun test`).
