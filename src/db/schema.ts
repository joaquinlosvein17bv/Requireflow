export const INITIAL_SCHEMA = `
-- Projects table
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    root_path TEXT,
    archive_threshold_hours INTEGER NOT NULL DEFAULT 24,
    created_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
CREATE INDEX IF NOT EXISTS idx_projects_root_path ON projects(root_path);

-- Thematic Sections
CREATE TABLE IF NOT EXISTS sections (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#6366f1',
    position INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sections_project ON sections(project_id, position);

-- Tasks & Backlog
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    section_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL CHECK(type IN ('feature', 'fix', 'bugfix', 'chore', 'refactor', 'debt')) DEFAULT 'feature',
    priority TEXT NOT NULL CHECK(priority IN ('low', 'medium', 'high', 'blocker')) DEFAULT 'medium',
    status TEXT NOT NULL CHECK(status IN ('backlog', 'todo', 'in_progress', 'done', 'archived')) DEFAULT 'todo',
    position INTEGER NOT NULL DEFAULT 0,
    story_points INTEGER,
    tags TEXT,
    started_at DATETIME,
    completed_at DATETIME,
    archived_at DATETIME,
    cycle_time_seconds INTEGER,
    notes TEXT,
    created_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(section_id) REFERENCES sections(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_section ON tasks(section_id);
CREATE INDEX IF NOT EXISTS idx_tasks_completed_at ON tasks(completed_at);
CREATE INDEX IF NOT EXISTS idx_tasks_archived_at ON tasks(archived_at);

-- Permanent History Changelog
CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    section_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL,
    priority TEXT NOT NULL,
    notes TEXT,
    tags TEXT,
    started_at DATETIME,
    completed_at DATETIME,
    archived_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    cycle_time_seconds INTEGER,
    total_cycle_time_ms INTEGER,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_history_project_archived ON history(project_id, archived_at);

-- Full Text Search Virtual Table
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
    id UNINDEXED,
    task_id UNINDEXED,
    project_id UNINDEXED,
    title,
    description,
    notes,
    tokenize = 'porter unicode61'
);

-- Triggers to synchronize history with history_fts
CREATE TRIGGER IF NOT EXISTS trg_history_ai AFTER INSERT ON history BEGIN
    INSERT INTO history_fts(id, task_id, project_id, title, description, notes)
    VALUES (
        new.id,
        new.task_id,
        new.project_id,
        new.title,
        coalesce(new.description, ''),
        coalesce(new.notes, '')
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_history_ad AFTER DELETE ON history BEGIN
    DELETE FROM history_fts WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_history_au AFTER UPDATE ON history BEGIN
    DELETE FROM history_fts WHERE id = old.id;
    INSERT INTO history_fts(id, task_id, project_id, title, description, notes)
    VALUES (
        new.id,
        new.task_id,
        new.project_id,
        new.title,
        coalesce(new.description, ''),
        coalesce(new.notes, '')
    );
END;

-- Key-value system config
CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- Schema migrations tracker
CREATE TABLE IF NOT EXISTS _schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
`;
