CREATE TABLE IF NOT EXISTS memory_documents (
    user_id        TEXT NOT NULL,
    bot_id         TEXT NOT NULL DEFAULT '',
    target         TEXT NOT NULL CHECK (target IN ('user', 'memory')),
    text           TEXT NOT NULL DEFAULT '',
    revision       INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at     TEXT NOT NULL,
    deleted_at     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, bot_id, target),
    CHECK (
        (target = 'user' AND bot_id = '')
        OR (target = 'memory' AND bot_id <> '')
    )
);
CREATE INDEX IF NOT EXISTS idx_memory_documents_updated
    ON memory_documents(user_id, updated_at);

CREATE TABLE IF NOT EXISTS memory_legacy_migration (
    source_kind TEXT NOT NULL,
    source_id   TEXT NOT NULL,
    outcome     TEXT NOT NULL,
    migrated_at TEXT NOT NULL,
    PRIMARY KEY (source_kind, source_id)
);

CREATE TABLE IF NOT EXISTS memory_migration_state (
    key          TEXT PRIMARY KEY NOT NULL,
    completed_at TEXT NOT NULL
);
