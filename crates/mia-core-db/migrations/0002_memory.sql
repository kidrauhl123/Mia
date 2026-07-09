CREATE TABLE IF NOT EXISTS memory_entries (
    id                         TEXT PRIMARY KEY NOT NULL,
    user_id                    TEXT NOT NULL,
    bot_id                     TEXT NOT NULL DEFAULT '',
    session_id                 TEXT NOT NULL DEFAULT '',
    scope                      TEXT NOT NULL,
    text                       TEXT NOT NULL,
    confidence                 REAL NOT NULL DEFAULT 1,
    source                     TEXT NOT NULL DEFAULT '',
    origin_engine              TEXT NOT NULL DEFAULT '',
    origin_native_session_id   TEXT NOT NULL DEFAULT '',
    source_message_ids_json    TEXT NOT NULL DEFAULT '[]',
    linked_memory_ids_json     TEXT NOT NULL DEFAULT '[]',
    policy_result_json         TEXT NOT NULL DEFAULT '{}',
    hash                       TEXT NOT NULL,
    text_normalized            TEXT NOT NULL,
    priority                   INTEGER NOT NULL DEFAULT 0,
    pinned                     INTEGER NOT NULL DEFAULT 0,
    created_at                 TEXT NOT NULL,
    updated_at                 TEXT NOT NULL,
    last_used_at               TEXT NOT NULL DEFAULT '',
    expires_at                 TEXT NOT NULL DEFAULT '',
    metadata_json              TEXT NOT NULL DEFAULT '{}',
    deleted_at                 TEXT NOT NULL DEFAULT '',
    revision                   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_entries(user_id, bot_id, session_id, scope);
CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory_entries(updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_hash ON memory_entries(hash);

CREATE TABLE IF NOT EXISTS memory_events (
    id             TEXT PRIMARY KEY NOT NULL,
    memory_id      TEXT NOT NULL,
    event          TEXT NOT NULL,
    actor          TEXT NOT NULL,
    before_json    TEXT NOT NULL DEFAULT '{}',
    after_json     TEXT NOT NULL DEFAULT '{}',
    created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_events_memory_id ON memory_events(memory_id);
