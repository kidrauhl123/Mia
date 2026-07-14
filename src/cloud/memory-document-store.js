const ENTRY_SEPARATOR = "\n§\n";
const LIMITS = Object.freeze({ user: 1375, memory: 2200 });
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const MAX_PUSH_DOCUMENTS = 100;

class MemoryDocumentStoreError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "MemoryDocumentStoreError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) {
  throw new MemoryDocumentStoreError(code, status);
}

function codePointLength(value) {
  return Array.from(String(value || "")).length;
}

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

function serializeEntries(entries) {
  return entries.map(normalizeText).join(ENTRY_SEPARATOR);
}

function deserializeEntries(text) {
  const source = String(text ?? "");
  if (!source) return [];
  const entries = source.split(ENTRY_SEPARATOR);
  if (entries.some((entry) => !normalizeText(entry))) fail("invalid_document");
  if (serializeEntries(entries) !== source) fail("invalid_document");
  return entries;
}

function policyError(text) {
  const value = String(text || "");
  if (/(^|\n)\s*§\s*(\n|$)/u.test(value)) return "invalid_separator";
  if (/[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/u.test(value)) {
    return "invisible_unicode";
  }
  const lower = value.toLowerCase();
  if (containsAny(lower, [
    "ignore system instructions",
    "ignore the system instructions",
    "ignore developer instructions",
    "ignore the developer instructions",
    "ignore previous instructions",
    "ignore all previous instructions",
    "忽略 system",
    "忽略之前的 system",
    "忽略先前的 system",
    "忽略 developer",
    "忽略系统指令",
    "忽略系统提示",
    "忽略开发者指令",
    "忽略之前的指令",
    "忽略先前指令",
    "无视系统指令",
    "无视开发者指令",
    "<system",
    "</system",
    "<developer",
    "</developer",
    "[system]",
    "[developer]"
  ])) {
    return "prompt_override";
  }
  if (containsAny(lower, ["authorized_keys", "ssh-rsa", "ssh-ed25519", "~/.ssh", "permitrootlogin"])) {
    return "ssh_backdoor";
  }
  const pipeToShell = (lower.includes("curl ") || lower.includes("wget ")) &&
    containsAny(lower, ["| sh", "|sh", "| bash", "|bash", "| zsh", "|zsh"]);
  if (pipeToShell || containsAny(lower, [
    "crontab ",
    "launchctl load",
    "launchctl bootstrap",
    "systemctl enable",
    ">> ~/.bashrc",
    ">> ~/.zshrc",
    ">> ~/.profile",
    "> ~/.bashrc",
    "> ~/.zshrc",
    "> ~/.profile"
  ])) {
    return "persistent_command";
  }
  if (containsAny(lower, [
    "api key",
    "api_key",
    "apikey",
    "api secret",
    "client secret",
    "client_secret",
    "secret=",
    "secret:",
    "bearer ",
    "password",
    "passwd",
    "private key",
    "-----begin private key-----",
    "-----begin rsa private key-----",
    "-----begin openssh private key-----",
    "access_token",
    "refresh_token",
    "密码",
    "口令",
    "私钥"
  ])) {
    return "credential_material";
  }
  return "";
}

function containsAny(value, needles) {
  return needles.some((needle) => value.includes(needle));
}

function validateEntry(text) {
  const normalized = normalizeText(text);
  if (!normalized) fail("content_required");
  const violation = policyError(normalized);
  if (violation) fail(violation);
  return normalized;
}

function normalizeIdentity(ownerId, input = {}) {
  const userId = String(ownerId || "");
  if (!userId) fail("owner_required", 401);
  const suppliedOwner = input.userId ?? input.user_id;
  if (suppliedOwner != null && String(suppliedOwner) !== userId) fail("owner_mismatch", 403);

  const target = String(input.target || "");
  const botId = String(input.botId ?? input.bot_id ?? "");
  if (target !== "user" && target !== "memory") fail("invalid_target");
  if (target === "memory" && !botId) fail("bot_id_required");
  if (target === "user" && botId) fail("bot_id_not_allowed");
  return { userId, target, botId: target === "user" ? "" : botId };
}

function rowToDocument(row, identity) {
  if (!row) {
    return {
      userId: identity.userId,
      botId: identity.botId,
      target: identity.target,
      text: "",
      revision: 0,
      updatedAt: "",
      deletedAt: ""
    };
  }
  return {
    userId: row.user_id,
    botId: row.bot_id,
    target: row.target,
    text: row.text,
    revision: Number(row.revision),
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

function createMemoryDocumentStore(db, deps = {}) {
  if (!db) throw new TypeError("createMemoryDocumentStore: db required");
  const now = typeof deps.now === "function" ? deps.now : () => new Date().toISOString();
  const selectDocument = db.prepare(
    "SELECT user_id, bot_id, target, text, revision, updated_at, deleted_at " +
    "FROM memory_documents WHERE user_id = ? AND bot_id = ? AND target = ?"
  );
  const upsertDocument = db.prepare(
    "INSERT INTO memory_documents " +
    "(user_id, bot_id, target, text, revision, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(user_id, bot_id, target) DO UPDATE SET " +
    "text = excluded.text, revision = excluded.revision, " +
    "updated_at = excluded.updated_at, deleted_at = excluded.deleted_at"
  );

  function getDocument(ownerId, input) {
    const identity = normalizeIdentity(ownerId, input);
    return rowToDocument(
      selectDocument.get(identity.userId, identity.botId, identity.target),
      identity
    );
  }

  function validateDocumentText(target, text, deletedAt) {
    if (deletedAt) return "";
    const entries = deserializeEntries(String(text ?? ""));
    for (const entry of entries) validateEntry(entry);
    if (codePointLength(String(text ?? "")) > LIMITS[target]) fail("capacity_exceeded");
    return String(text ?? "");
  }

  function applyDocument(ownerId, input = {}) {
    const identity = normalizeIdentity(ownerId, input);
    const revision = Number(input.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) fail("invalid_revision");
    const deletedAt = String(input.deletedAt ?? input.deleted_at ?? "");
    const text = validateDocumentText(identity.target, input.text, deletedAt);
    const current = getDocument(ownerId, identity);
    const sameState = current.revision > 0 && current.text === text && current.deletedAt === deletedAt;

    if (current.revision > 0 && revision <= current.revision) {
      if (sameState) return { kind: "accepted", document: current, noOp: true };
      return { kind: "conflict", document: current, error: "revision_conflict" };
    }

    const updatedAt = String(input.updatedAt ?? input.updated_at ?? "") || String(now());
    upsertDocument.run(
      identity.userId,
      identity.botId,
      identity.target,
      text,
      revision,
      updatedAt,
      deletedAt
    );
    return { kind: "accepted", document: getDocument(ownerId, identity), noOp: false };
  }

  function pushDocuments(ownerId, documents) {
    const input = Array.isArray(documents) ? documents : [];
    if (input.length > MAX_PUSH_DOCUMENTS) fail("too_many_documents", 413);
    const result = { accepted: [], conflicts: [], errors: [], serverTime: String(now()) };
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of input) {
        try {
          const applied = applyDocument(ownerId, item);
          if (applied.kind === "conflict") {
            result.conflicts.push({ document: applied.document, error: applied.error });
          }
          else result.accepted.push({ document: applied.document, noOp: applied.noOp });
        } catch (error) {
          if (!(error instanceof MemoryDocumentStoreError)) throw error;
          result.errors.push({
            target: String(item?.target || ""),
            botId: String(item?.botId ?? item?.bot_id ?? ""),
            error: error.code
          });
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* original error is actionable */ }
      throw error;
    }
    return result;
  }

  function listDocuments(ownerId, options = {}) {
    const userId = String(ownerId || "");
    if (!userId) fail("owner_required", 401);
    const requestedLimit = Number(options.limit);
    const limit = Math.min(
      Math.max(1, Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : DEFAULT_LIST_LIMIT),
      MAX_LIST_LIMIT
    );
    const since = String(options.since || "");
    const rows = since
      ? db.prepare(
        "SELECT user_id, bot_id, target, text, revision, updated_at, deleted_at " +
        "FROM memory_documents WHERE user_id = ? AND updated_at > ? " +
        "ORDER BY updated_at ASC, target ASC, bot_id ASC LIMIT ?"
      ).all(userId, since, limit)
      : db.prepare(
        "SELECT user_id, bot_id, target, text, revision, updated_at, deleted_at " +
        "FROM memory_documents WHERE user_id = ? " +
        "ORDER BY updated_at ASC, target ASC, bot_id ASC LIMIT ?"
      ).all(userId, limit);
    return {
      documents: rows.map((row) => rowToDocument(row, {
        userId: row.user_id,
        botId: row.bot_id,
        target: row.target
      })),
      serverTime: String(now())
    };
  }

  function mutationFailure(action, target, currentEntries, code) {
    const usedChars = codePointLength(serializeEntries(currentEntries));
    return {
      success: false,
      action,
      target,
      currentEntries,
      usedChars,
      limitChars: LIMITS[target],
      usagePercent: usedChars * 100 / LIMITS[target],
      noOp: false,
      error: code,
      suggestion: suggestionFor(code)
    };
  }

  function mutate(ownerId, botId, request = {}) {
    const action = String(request.action || "");
    const target = String(request.target || "");
    let identity;
    try {
      identity = normalizeIdentity(ownerId, { target, botId: target === "memory" ? botId : "" });
    } catch (error) {
      if (!(error instanceof MemoryDocumentStoreError)) throw error;
      return mutationFailure(action, target === "user" ? "user" : "memory", [], error.code);
    }
    if (!Object.hasOwn(LIMITS, target)) return mutationFailure(action, target, [], "invalid_target");
    if (!new Set(["add", "replace", "remove"]).has(action)) {
      const current = getDocument(ownerId, identity);
      return mutationFailure(action, target, deserializeEntries(current.text), "invalid_action");
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      const current = getDocument(ownerId, identity);
      const currentEntries = current.deletedAt ? [] : deserializeEntries(current.text);
      let nextEntries = [...currentEntries];
      let normalizedContent = "";
      let normalizedOldText = "";

      try {
        if (action === "add" || action === "replace") normalizedContent = validateEntry(request.content);
        else if (request.content != null && normalizeText(request.content)) fail("unexpected_content");
        if (action === "replace" || action === "remove") {
          normalizedOldText = normalizeText(request.oldText);
          if (!normalizedOldText) fail("old_text_required");
        }

        if (action === "add") {
          if (currentEntries.includes(normalizedContent)) {
            db.exec("COMMIT");
            return mutationSuccess(action, target, currentEntries, true);
          }
          nextEntries.push(normalizedContent);
        } else {
          const matches = currentEntries
            .map((entry, index) => entry.includes(normalizedOldText) ? index : -1)
            .filter((index) => index >= 0);
          if (matches.length === 0) fail("old_text_not_found");
          if (matches.length > 1) fail("ambiguous_old_text");
          if (action === "replace" && currentEntries[matches[0]] === normalizedContent) {
            db.exec("COMMIT");
            return mutationSuccess(action, target, currentEntries, true);
          }
          if (action === "replace") nextEntries[matches[0]] = normalizedContent;
          else nextEntries.splice(matches[0], 1);
        }

        const text = serializeEntries(nextEntries);
        if (codePointLength(text) > LIMITS[target]) fail("capacity_exceeded");
        upsertDocument.run(
          identity.userId,
          identity.botId,
          identity.target,
          text,
          current.revision + 1,
          String(now()),
          ""
        );
        db.exec("COMMIT");
        return mutationSuccess(action, target, nextEntries, false);
      } catch (error) {
        if (!(error instanceof MemoryDocumentStoreError)) throw error;
        db.exec("ROLLBACK");
        return mutationFailure(action, target, currentEntries, error.code);
      }
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* original error is actionable */ }
      throw error;
    }
  }

  function mutationSuccess(action, target, entries, noOp) {
    const usedChars = codePointLength(serializeEntries(entries));
    return {
      success: true,
      action,
      target,
      currentEntries: entries,
      usedChars,
      limitChars: LIMITS[target],
      usagePercent: usedChars * 100 / LIMITS[target],
      noOp,
      error: null,
      suggestion: null
    };
  }

  return { getDocument, listDocuments, applyDocument, pushDocuments, mutate };
}

function suggestionFor(error) {
  if (error === "capacity_exceeded") return "Use replace or remove to free space, then retry.";
  if (error === "old_text_not_found") return "Use an exact unique substring from the current entries.";
  if (error === "ambiguous_old_text") return "Provide a substring that matches exactly one entry.";
  if (error === "content_required" || error === "old_text_required") {
    return "Provide the required action field.";
  }
  if (new Set([
    "prompt_override",
    "credential_material",
    "ssh_backdoor",
    "persistent_command",
    "invisible_unicode",
    "invalid_separator"
  ]).has(error)) {
    return "Rewrite the entry as a safe durable fact, then retry.";
  }
  return null;
}

module.exports = {
  ENTRY_SEPARATOR,
  LIMITS,
  MemoryDocumentStoreError,
  createMemoryDocumentStore
};
