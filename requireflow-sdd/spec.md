# Spec: RequireFlow Requirements & Scenarios

## 1. Overview
This document specifies the exact behavioral requirements and testable scenarios for **RequireFlow**, a local-first backlog, implementation tracker, and efficiency analyzer for developers and AI agents.

---

## 2. Requirements & Scenarios

### Requirement 1: Project Auto-Detection and Management
The system MUST automatically detect the active project from the current working directory (`cwd`) by locating the nearest `.git` directory or falling back to the directory basename. The system SHALL also allow explicit project creation and switching.

#### Scenario: Auto-detecting project from Git root
- **GIVEN** a terminal session inside `/home/user/projects/my-awesome-app/src`
- **WHEN** the command `requireflow list` or an MCP tool is invoked without a project parameter
- **THEN** RequireFlow resolves the project name as `"my-awesome-app"` based on the Git repository root
- **AND** automatically creates or loads the project record in the local SQLite database.

#### Scenario: Creating a project explicitly
- **GIVEN** the RequireFlow web dashboard or CLI
- **WHEN** a user or agent submits a request to create a project named `"Mobile App"` with description `"React Native client"`
- **THEN** the project is stored in the database
- **AND** becomes selectable in the UI and CLI.

---

### Requirement 2: Task, Implementation, and Bugfix Lifecycle
The system MUST support creating, prioritizing, starting, updating, and completing tasks. Each task MUST maintain an explicit type (`feature`, `fix`, `chore`, `refactor`), priority (`low`, `medium`, `high`, `blocker`), and state (`backlog`, `todo`, `in_progress`, `done`, `archived`).

#### Scenario: Agent creates a task or bugfix
- **GIVEN** an active project `"Backend API"`
- **WHEN** an AI agent or user creates a task with title `"Fix N+1 query in user list"`, type `"fix"`, and priority `"high"`
- **THEN** the task is stored with status `"todo"`
- **AND** the position is assigned to place it in the project backlog.

#### Scenario: Starting a task records startedAt
- **GIVEN** a task in status `"todo"` or `"backlog"` with ID `task-101`
- **WHEN** an agent calls `task_start(id: "task-101")` or the user drags the card to "In Progress"
- **THEN** the status transitions to `"in_progress"`
- **AND** `startedAt` is recorded with the current UTC timestamp if not previously set.

#### Scenario: Completing a task records completedAt and calculates cycle time
- **GIVEN** a task in status `"in_progress"` that started 45 minutes ago
- **WHEN** an agent calls `task_complete(id: "task-101", notes: "Added database index")` or the user moves the card to "Done"
- **THEN** the status transitions to `"done"`
- **AND** `completedAt` is recorded with the current UTC timestamp
- **AND** the cycle time duration is computed as `45 minutes`.

---

### Requirement 3: Kanban Board & Thematic Sections
The system MUST provide an active Kanban board view displaying columns for `Backlog`, `In Progress`, and `Recently Done`. The system MUST support thematic sections (e.g. `Frontend`, `Backend`, `Database`) with customizable colors.

#### Scenario: Visualizing tasks on the active Kanban board
- **GIVEN** a project with 3 backlog tasks, 1 in-progress task, and 2 recently done tasks
- **WHEN** the user opens the Kanban view in the Web UI
- **THEN** each task card appears in its respective column with title, priority badge, type badge, and section tag
- **AND** in-progress cards display a live duration counter since `startedAt`.

#### Scenario: Filtering Kanban board by section
- **GIVEN** tasks categorized into sections `"Backend"` and `"Frontend"`
- **WHEN** the user clicks on the section chip `[Backend]`
- **THEN** only tasks belonging to the `"Backend"` section are visible on the board.

---

### Requirement 4: Dual Archival from Board to History (Automatic & Manual)
To prevent Kanban board clutter, completed tasks in the `"done"` column MUST transition to the `"archived"` state and move into the permanent **History** view. The system MUST support both automatic time-based archival and immediate manual archival.

#### Scenario: Manual archival of completed tasks
- **GIVEN** 5 tasks currently residing in the `"done"` column of the Kanban board
- **WHEN** the user clicks the "Archivar Completadas al Historial" button or the agent runs `requireflow archive`
- **THEN** all tasks in the `"done"` column transition to `"archived"`
- **AND** the `"done"` column is cleared
- **AND** the 5 tasks appear in the History Changelog view.

#### Scenario: Automatic archival of stale completed tasks
- **GIVEN** an automatic archival threshold configured to `24 hours`
- **AND** a task in `"done"` status that was completed 25 hours ago
- **WHEN** the RequireFlow background ticker runs or the project is loaded
- **THEN** the task is automatically transitioned to `"archived"`
- **AND** removed from the active Kanban view into the permanent History view.

---

### Requirement 5: Permanent History Changelog View
The system MUST maintain a dedicated History view displaying a searchable, filterable log of all implemented tasks and bugfixes.

#### Scenario: Inspecting implementation history
- **GIVEN** 20 archived tasks completed across multiple days
- **WHEN** the user navigates to the History tab
- **THEN** the list displays tasks grouped by date
- **AND** each entry shows the task title, type (feature/fix), resolution notes, total cycle time, and start/finish timestamps
- **AND** a search bar filters entries by keyword or section.

---

### Requirement 6: AI Efficiency Metrics Calculation
The system MUST aggregate task lifecycle timestamps to compute development efficiency metrics.

#### Scenario: Calculating cycle time and throughput
- **GIVEN** 10 completed tasks in the project with recorded `startedAt` and `completedAt` timestamps
- **WHEN** the user opens the Efficiency tab
- **THEN** the system displays:
  - Average Cycle Time (e.g., `28m 14s`)
  - Total Throughput (tasks completed today / this week)
  - Work Distribution (e.g. 70% features, 30% bugfixes)
  - Recent Velocity timeline chart or table.

---

### Requirement 7: Model Context Protocol (MCP) Interface for AI Agents
The system MUST provide an MCP server communicating over standard I/O (`stdio`) with JSON-RPC 2.0.

#### Scenario: Agent retrieves next prioritized task via MCP
- **GIVEN** an active project with 3 pending tasks of priorities `low`, `high`, and `blocker`
- **WHEN** an AI agent invokes the MCP tool `task_next`
- **THEN** the system returns the task with priority `blocker`
- **AND** includes its ID, title, description, and section.

#### Scenario: Agent completes task and logs correction via MCP
- **GIVEN** an in-progress task with ID `task-202`
- **WHEN** an agent calls `task_complete(id: "task-202", notes: "Patched memory leak in cache store")`
- **THEN** the task is marked done with completion timestamp
- **AND** the notes are persisted to the history record
- **AND** the MCP response confirms success with the elapsed duration.

---

### Requirement 8: Embedded Vanilla HTML/CSS Web Dashboard
The system MUST embed and serve a responsive, standalone Web UI written purely in standard HTML5, CSS3, and modern Vanilla JavaScript without external CDN dependencies or npm bundle steps.

#### Scenario: Launching local web dashboard via CLI
- **GIVEN** RequireFlow installed on the developer machine
- **WHEN** the user executes `requireflow ui` in a terminal
- **THEN** the Bun HTTP server starts on port `3456` (or next free port)
- **AND** automatically opens the dashboard in the default web browser
- **AND** displays the Projects, Kanban, Backlog, History, and Efficiency tabs.
