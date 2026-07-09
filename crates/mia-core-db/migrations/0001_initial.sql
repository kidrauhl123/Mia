CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
    id                 TEXT PRIMARY KEY NOT NULL,
    kind               TEXT NOT NULL,
    display_name       TEXT NOT NULL,
    base_url           TEXT,
    api_key_env        TEXT,
    encrypted_api_key  TEXT,
    api_mode           TEXT,
    auth_type          TEXT NOT NULL DEFAULT 'api_key',
    models_json        TEXT NOT NULL DEFAULT '[]',
    enabled            INTEGER NOT NULL DEFAULT 1,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_providers_kind ON providers(kind);

CREATE TABLE IF NOT EXISTS bots (
    id                TEXT PRIMARY KEY NOT NULL,
    display_name      TEXT NOT NULL,
    avatar_json       TEXT NOT NULL DEFAULT '{}',
    capability_json   TEXT NOT NULL DEFAULT '{}',
    identity_json     TEXT NOT NULL DEFAULT '{}',
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_runtime_bindings (
    bot_id           TEXT PRIMARY KEY NOT NULL,
    runtime_kind     TEXT NOT NULL,
    binding_json     TEXT NOT NULL DEFAULT '{}',
    updated_at       INTEGER NOT NULL,
    FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversations (
    id              TEXT PRIMARY KEY NOT NULL,
    kind            TEXT NOT NULL,
    title           TEXT NOT NULL,
    bot_id          TEXT,
    runtime_json    TEXT NOT NULL DEFAULT '{}',
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_bot_id ON conversations(bot_id);

CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    content_json    TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'complete',
    seq             INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    UNIQUE(conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq ON messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

CREATE TABLE IF NOT EXISTS tasks (
    id                TEXT PRIMARY KEY NOT NULL,
    kind              TEXT NOT NULL,
    schedule_json     TEXT NOT NULL,
    target_json       TEXT NOT NULL,
    instructions      TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT 'active',
    last_run_at       INTEGER,
    next_run_at       INTEGER,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_next_run ON tasks(status, next_run_at);

CREATE TABLE IF NOT EXISTS mcp_servers (
    id                 TEXT PRIMARY KEY NOT NULL,
    name               TEXT NOT NULL UNIQUE,
    transport          TEXT NOT NULL,
    config_json        TEXT NOT NULL DEFAULT '{}',
    enabled            INTEGER NOT NULL DEFAULT 0,
    last_test_json     TEXT NOT NULL DEFAULT '{}',
    deleted_at         INTEGER,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
    server_id           TEXT PRIMARY KEY NOT NULL,
    token_json          TEXT NOT NULL,
    updated_at          INTEGER NOT NULL,
    FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cloud_state (
    key        TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event_cursors (
    source     TEXT PRIMARY KEY NOT NULL,
    cursor     TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
