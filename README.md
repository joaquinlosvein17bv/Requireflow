# RequireFlow ⚡

> **Local-first Backlog, Task & Bugfix Lifecycle Engine with Embedded Vanilla Dashboard and Agentic MCP Protocol**  
> *Optimized for AI coding agent task execution, cycle-time efficiency, and standalone local deployment.*

---

## 🧭 Overview

`requireflow` is a single-binary, local-first developer utility powered by **Bun** and **embedded SQLite**. While memory tools persist unstructured prompt memories and architectural observations, **RequireFlow records and orchestrates actionable tasks, bugfixes, backlog sections, and delivery efficiency metrics**.

### Core Pillars
1. **Local-First Zero Config**: Zero external database servers required. Operates on `~/.requireflow/requireflow.db` using WAL mode.
2. **AI Agent MCP Integration**: Exposes 10 specialized Model Context Protocol (MCP) tools over stdio (`rf_task_next`, `rf_task_add`, `rf_task_complete`, `rf_archive_run`, etc.), enabling AI coding agents to autonomously pick up work, track progress, and log completions.
3. **Dual Archival Lifecycle**: Solves Kanban board clutter. Completed tasks don't sit in "Done" indefinitely—they move to the permanent searchable History both **automatically** (24h threshold) and **manually** (via button/CLI/API).
4. **Embedded Vanilla Dashboard**: Ultra-fast HTML5/CSS3/JS UI served via `Bun.serve()` with zero build step, zero heavy frontend frameworks, instant loading, and sub-5ms response times.
5. **Efficiency & Cycle Time Analytics**: Tracks exact Lead Time (`created_at` to `completed_at`) and Cycle Time (`started_at` to `completed_at`), computing bugfix velocity and team/solo development speed.

---

## 🚀 Quick Start

### 1. Requirements
- **Bun**: v1.1.0 or newer ([bun.sh](https://bun.sh))

### 2. Installation
```bash
# Clone & install dependencies
bun install
```

### 3. Running the Test Suite
```bash
bun test
```

### 4. Starting the Web UI Dashboard
```bash
# Starts embedded Web UI on http://localhost:4242
bun run ui:dev
# Or using CLI
bun run start ui --port 4242
```

### 5. Running the MCP Stdio Server (for AI Agents)
```bash
bun run start mcp
```

### 6. Compiling Single Standalone Binary
```bash
bun run build
# Produces dist/requireflow (or dist/requireflow.exe on Windows)
```

---

## 💻 CLI Commands

```bash
# Link or initialize current directory as active project
requireflow init

# View status of active board (To Do, In Progress, Done)
requireflow status

# Add a task to backlog
requireflow add "Fix N+1 query in user list" -t bugfix -p high -s Backend

# Get the next highest-priority task to work on
requireflow next
requireflow next --json

# Start a task (records started_at)
requireflow start <task-id>

# Complete a task (records completed_at and calculates cycle time)
requireflow done <task-id> -m "Added index on user_id"

# Flush completed tasks to permanent history
requireflow archive --force

# Launch web dashboard
requireflow ui --port 4242

# Start MCP stdio server
requireflow mcp

# View efficiency statistics
requireflow stats
```

---

## 🔌 Model Context Protocol (MCP) Configuration

To connect `requireflow` with Cursor, Claude Desktop, Antigravity, or OpenCode:

```json
{
  "mcpServers": {
    "requireflow": {
      "command": "bun",
      "args": ["run", "path/to/requireflow/bin/requireflow.ts", "mcp"]
    }
  }
}
```

Or using the compiled standalone executable:

```json
{
  "mcpServers": {
    "requireflow": {
      "command": "path/to/requireflow/dist/requireflow",
      "args": ["mcp"]
    }
  }
}
```

### Registered Tools:
1. `rf_project_detect` / `project_current`: Auto-resolve active project.
2. `rf_task_list` / `task_list`: List tasks with filters.
3. `rf_task_next` / `task_next`: Get single highest-priority task.
4. `rf_task_add` / `task_create`: Add task to backlog.
5. `rf_task_start` / `task_start`: Start task (started_at timestamp).
6. `rf_task_complete` / `task_complete`: Complete task (completed_at & cycle time).
7. `rf_task_update` / `task_update`: Modify task fields.
8. `rf_archive_run` / `task_archive_done`: Flush Done to History.
9. `rf_history_search` / `history_list`: FTS5 full-text search across past work.
10. `rf_efficiency_stats` / `efficiency_stats`: Cycle time & throughput metrics.

---

## 📦 Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `REQUIREFLOW_DB_PATH` | `~/.requireflow/requireflow.db` | Path to SQLite database file |
| `REQUIREFLOW_PORT` | `4242` | HTTP port for REST API and Web UI |
| `REQUIREFLOW_HOST` | `127.0.0.1` | Binding host for HTTP server |
| `REQUIREFLOW_ARCHIVE_HOURS` | `24` | Inactivity threshold before completed tasks auto-archive |
