# agent.md

The agent installation and lifecycle guide lives in **[AGENTS.md](./AGENTS.md)**.

This file used to be a byte-for-byte copy, which drifted every time one of them
was edited. It now only points to the single source of truth so existing tools
that look for `agent.md` keep working.

Quick summary of what AGENTS.md covers:

- Installation, build and global binary setup for RequireFlow.
- MCP server registration for Cursor, Claude Desktop, Antigravity, Windsurf, Cline and Roo Code.
- The task lifecycle (intake, selection, start, complete, archive) and the 12 MCP tools.
- Project registration: `rf_project_detect` is read-only; use `rf_project_add` to register a project.
