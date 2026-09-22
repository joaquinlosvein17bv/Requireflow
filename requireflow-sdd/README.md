# RequireFlow — Specification & Handoff Guide

> **Local-first Backlog, Task & Bugfix Lifecycle Engine with Embedded Vanilla Dashboard and Agentic MCP Protocol**  
> *Inspired by the architecture of [Gentleman-Programming/engram](https://github.com/Gentleman-Programming/engram), optimized for development task execution, cycle-time efficiency, and standalone local deployment.*

---

## 🧭 Executive Summary

`requireflow` is a single-binary, local-first developer utility powered by **Bun** and **embedded SQLite**. While Engram records unstructured prompt memories and architectural observations, **RequireFlow records and orchestrates actionable tasks, bugfixes, backlog sections, and delivery efficiency metrics**.

### Core Pillars
1. **Local-First Zero Config**: Zero external database servers required. Operates on `~/.requireflow/requireflow.db` using WAL mode.
2. **AI Agent MCP Integration**: Exposes 10 specialized Model Context Protocol (MCP) tools over stdio (`rf_task_next`, `rf_task_add`, `rf_task_complete`, `rf_archive_run`, etc.), enabling AI coding agents to autonomously pick up work, track progress, and log completions.
3. **Dual Archival Lifecycle**: Solves Kanban board clutter. Completed tasks don't sit in "Done" indefinitely—they move to the permanent searchable History both **automatically** (24h threshold) and **manually** (via button/CLI/API).
4. **Embedded Vanilla Dashboard**: Ultra-fast HTML5/CSS3/JS UI served via `Bun.serve()` with zero build step, zero heavy frontend frameworks, instant loading, and sub-5ms response times.
5. **Efficiency & Cycle Time Analytics**: Tracks exact Lead Time (`created_at` to `completed_at`) and Cycle Time (`started_at` to `completed_at`), computing bugfix velocity and team/solo development speed.

---

## 📂 SDD Artifacts in this Directory

This directory contains the complete Gentle AI Spec-Driven Development (SDD) blueprint ready for execution by an AI agent or software engineer:

| File | Description |
| :--- | :--- |
| [`proposal.md`](file:///C:/Users/meliodaslosven/Desktop/Projects/ManageProjects/requireflow-sdd/proposal.md) | Vision, problem statement, comparison against Engram, runtime tradeoffs, and boundaries. |
| [`spec.md`](file:///C:/Users/meliodaslosven/Desktop/Projects/ManageProjects/requireflow-sdd/spec.md) | Formal specification with 8 user requirements and GIVEN/WHEN/THEN acceptance criteria. |
| [`design.md`](file:///C:/Users/meliodaslosven/Desktop/Projects/ManageProjects/requireflow-sdd/design.md) | Technical architecture, SQLite DDL schema, dual archival algorithms, 10 MCP tools, REST endpoints, and UI layout. |
| [`tasks.md`](file:///C:/Users/meliodaslosven/Desktop/Projects/ManageProjects/requireflow-sdd/tasks.md) | 7 units with granular, test-driven checkboxes (`[ ]`) for phased implementation. |

---

## 🚀 Target Implementation Instructions (For the Executor Agent)

When bootstrapping the actual `requireflow` codebase in a new directory or repository:

### 1. Prerequisites
- **Bun**: v1.1.0 or newer ([bun.sh](https://bun.sh))

### 2. Project Initialization
```bash
mkdir requireflow
cd requireflow
bun init -y
```

### 3. Dependencies
```bash
# Add MCP SDK and schema validation
bun add @modelcontextprotocol/sdk zod

# Dev dependencies
bun add -d @types/bun typescript
```

### 4. Recommended Directory Layout
```text
requireflow/
├── bin/
│   └── requireflow.ts       # CLI executable shebang entrypoint
├── src/
│   ├── cli/
│   │   └── index.ts         # CLI subcommand dispatcher (init, ui, mcp, add, etc.)
│   ├── db/
│   │   ├── connection.ts    # bun:sqlite connection, WAL mode, path resolution
│   │   ├── schema.ts        # DDL tables (projects, sections, tasks, history) + FTS5
│   │   └── migrations.ts    # Schema migration runner
│   ├── domain/
│   │   ├── project.ts       # Git root auto-detection & project resolution
│   │   ├── section.ts       # Backlog thematic sections CRUD
│   │   ├── task.ts          # Task state machine (todo -> in_progress -> done)
│   │   ├── archive.ts       # Dual archival engine (auto threshold + manual flush)
│   │   ├── history.ts       # Searchable changelog & FTS5 full-text queries
│   │   └── efficiency.ts    # Cycle time, lead time, and velocity calculations
│   ├── mcp/
│   │   ├── server.ts        # Stdio MCP Server setup
│   │   └── tools.ts         # 10 MCP tools definition & handlers
│   ├── server/
│   │   ├── http.ts          # Bun.serve() HTTP server & static file host
│   │   └── routes.ts        # REST API endpoints (/api/projects, /api/tasks, etc.)
│   └── ui/
│       ├── index.html       # Embedded HTML5 dashboard shell
│       ├── styles.css       # Clean, modern CSS with dark/light themes
│       └── app.js           # Vanilla ES6 client application
├── test/                    # Bun unit and integration tests
├── package.json
└── tsconfig.json
```

### 5. Running & Developing
```bash
# Run unit tests
bun test

# Start the Web UI dashboard on http://localhost:4242
bun run src/server/http.ts

# Start the MCP stdio server
bun run src/cli/index.ts mcp

# Compile single-file standalone binary
bun build --compile --minify --sourcemap ./bin/requireflow.ts --outfile dist/requireflow
```

---

## 🔌 Agent MCP Configuration Example

To connect `requireflow` with Cursor, Claude Desktop, Antigravity, or OpenCode:

```json
{
  "mcpServers": {
    "requireflow": {
      "command": "requireflow",
      "args": ["mcp"],
      "env": {
        "REQUIREFLOW_DB_PATH": "~/.requireflow/requireflow.db"
      }
    }
  }
}
```

Or when running from Bun source:
```json
{
  "mcpServers": {
    "requireflow": {
      "command": "bun",
      "args": ["run", "/path/to/requireflow/bin/requireflow.ts", "mcp"]
    }
  }
}
```

---

## 📦 Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `REQUIREFLOW_DB_PATH` | `~/.requireflow/requireflow.db` | Location of the SQLite database file |
| `REQUIREFLOW_PORT` | `4242` | Port for the embedded Web UI and REST API |
| `REQUIREFLOW_HOST` | `127.0.0.1` | Binding host for the HTTP server |
| `REQUIREFLOW_ARCHIVE_HOURS`| `24` | Inactivity threshold before completed tasks are auto-archived |
