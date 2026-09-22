# Change Proposal: RequireFlow — Local-First Backlog & Implementation Tracker

## 1. Executive Summary

**RequireFlow** (`requireflow`) is a lightweight, local-first backlog, implementation, and bugfix lifecycle tracker designed specifically for AI-assisted software development.

Inspired by the single-binary, agent-agnostic philosophy of [Engram](https://github.com/Gentleman-Programming/engram) (which persists conceptual memories and prompt context into local SQLite), **RequireFlow** focuses on the execution lifecycle of software development: **task backlogs, active Kanban flows, bugfix tracking, history archiving, and AI cycle-time efficiency metrics**.

Built with **Bun** and **native SQLite (`bun:sqlite`)**, RequireFlow requires zero external databases, zero cloud dependencies, and zero heavy build systems. It serves three unified interfaces:
1. **MCP Server (Model Context Protocol over `stdio`)**: Native tools for AI coding agents (`task_next`, `task_start`, `task_complete`, `task_create`, `task_list`, `history_list`).
2. **Local Web Dashboard (Vanilla HTML5 + CSS + JS)**: An embedded, ultra-fast UI (`< 5ms` response time) featuring active Kanban, Backlog, History Changelog, and Efficiency Metrics.
3. **CLI Interface (`requireflow`)**: Fast terminal management for developers.

---

## 2. Problem Statement

Modern AI coding agents (Claude Code, Cursor, Cline, Roo Code, Antigravity, Windsurf) frequently operate in stateless or semi-stateless sessions:
- **No Local Task State**: Agents lack a clean, local-first mechanism to know what tasks remain in the backlog, what is in progress, and what was previously implemented.
- **Overhead of Cloud Issue Trackers**: Services like Jira, Linear, or GitHub Projects require network access, API tokens, team setup, and introduce latency into rapid local agent iterations.
- **Kanban Clutter (The "Infinite Done" Anti-Pattern)**: Traditional Kanban boards accumulate dozens or hundreds of completed cards in the "Done" column, creating visual clutter and bloating context tokens when agents inspect the board.
- **Memory vs. Backlog Dichotomy**: While tools like Engram provide persistent memory for conceptual discoveries and prompt recovery, they are not designed to organize ordered backlogs, estimate story points, track cycle times, or visualize Kanban swimlanes.

---

## 3. Proposed Solution

RequireFlow introduces a local companion tool with a focused scope:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        AI Coding Assistants                            │
│           (Claude Code / Cursor / Cline / Antigravity / ...)          │
└──────────────────┬──────────────────────────────────┬──────────────────┘
                   │ MCP stdio                        │ Local HTTP REST
                   ▼                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        RequireFlow Core Engine                         │
│                    Powered by Bun (Single Binary)                      │
├────────────────────────────────────────────────────────────────────────┤
│  • Auto Project Resolver (Git Root / CWD)                              │
│  • Task & Correction Lifecycle Engine                                  │
│  • Board-to-History Auto & Manual Archival                             │
│  • Cycle Time & Efficiency Calculator                                  │
├────────────────────────────────────────────────────────────────────────┤
│  • Native Bun SQLite (~/.requireflow/requireflow.db)                   │
│  • Embedded Vanilla Web Dashboard (HTML5 / CSS / Vanilla JS)           │
└────────────────────────────────┬───────────────────────────────────────┘
                                 │ HTTP :3456
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     Local Developer Dashboard                          │
│     [ Projects ]  [ Kanban Board ]  [ Backlog ]  [ History ]  [ Stats ]│
└────────────────────────────────────────────────────────────────────────┘
```

### Core Innovations

1. **Local-First & Zero-Dependency (Bun + `bun:sqlite`)**:
   - Uses Bun's built-in SQLite engine with WAL mode enabled for high-concurrency and sub-millisecond query execution.
   - Can be compiled into a standalone, single executable via `bun build --compile --outfile requireflow`.
2. **The Clean Kanban & History Lifecycle**:
   - **Active Kanban**: Displays only current work (`Backlog`, `In Progress`, and `Recently Done`).
   - **Dual Archival (Auto + Manual)**:
     - **Automatic**: Tasks in `Done` older than a configurable threshold (e.g. 24 hours or after session rollover) automatically transition to the permanent `History` archive.
     - **Manual**: A single click ("Archivar al Historial") or CLI/MCP command instantly flushes completed tasks to History.
   - **History Archive**: A dedicated chronological changelog recording task title, type (feature/fix/refactor), started timestamp, completed timestamp, duration/cycle time, and implementation notes.
3. **Built-in Vanilla Web UI**:
   - Zero React/Vue/Angular build steps.
   - Served directly by Bun via `Bun.serve()`.
   - Dark and light theme via CSS custom properties.
   - Mobile-responsive and instant loading.
4. **Agent Integration via MCP**:
   - Provides native MCP tools so agents proactively pull the next task, start work (recording `startedAt`), complete work (recording `completedAt`), and log corrections.
5. **Efficiency Metrics**:
   - Real-time calculations for Cycle Time (duration from `startedAt` to `completedAt`), throughput per day/week, and ratio of features vs. bugfixes.

---

## 4. Scope & Boundaries

### In Scope
- Single-command installation (`bun install -g requireflow` or standalone binary).
- Local SQLite database located in user home (`~/.requireflow/requireflow.db`) with support for repository-local overrides (`.requireflow/data.db`).
- Auto-detection of projects based on current working directory (`cwd`) or Git repository name.
- Task CRUD operations with types: `feature`, `fix`, `chore`, `refactor`.
- Thematic sections/tags within projects (e.g., `frontend`, `backend`, `ui`, `auth`).
- Kanban board with drag-and-drop or status buttons.
- History view with search, date filters, and duration badges.
- Efficiency dashboard displaying average cycle time, completed tasks count, and velocity trend.
- Dual-trigger archival (automatic background ticker + manual button/API).
- MCP stdio server compatible with standard AI agent clients.
- CLI commands: `requireflow ui`, `requireflow mcp`, `requireflow add`, `requireflow list`, `requireflow next`, `requireflow start`, `requireflow done`, `requireflow archive`.

### Explicitly Out of Scope
- Multi-user authentication, JWT tokens, passwords, or team user management (this is a personal/solo developer tool, exactly like Engram).
- External cloud database syncing (can be synced via Git or local backups, but no cloud lock-in).
- Scrum ceremony bloat (no complex sprint planning, retrospectives, poker planning, or daily standup forms).
- Heavy frontend frameworks (strictly Vanilla HTML5, modern CSS, and plain JavaScript).

---

## 5. Success Criteria

1. **Zero External Setup**: Running `requireflow ui` opens the dashboard in the browser in `< 100ms` without installing database servers.
2. **Agent Compatibility**: Claude Code, Cursor, Cline, or Antigravity can connect via MCP stdio configuration and manage tasks autonomously.
3. **Clean Board Experience**: Completing 20 tasks does not clutter the board; tasks move smoothly to the History view automatically or on demand.
4. **Accuracy of Metrics**: Cycle time is automatically and accurately recorded in seconds/minutes/hours between `task_start` and `task_complete`.
