const { MemoryDocumentStoreError } = require("./memory-document-store.js");

const ROUTES = new Set([
  "GET /api/me/memory-documents",
  "POST /api/me/memory-documents/push",
  "POST /api/me/memory-documents/mutate"
]);

function response(status, body) {
  return { handled: true, status, body };
}

function errorResponse(status, error) {
  return response(status, { ok: false, error });
}

function authUserId(auth) {
  return String(auth?.user?.id || auth?.id || "");
}

function queryValue(query, key) {
  if (query && typeof query.get === "function") return query.get(key);
  return query?.[key];
}

function parseDecorations(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function createMemoryDocumentsApi(deps = {}) {
  const store = deps.store;
  if (!store) throw new TypeError("createMemoryDocumentsApi: store required");
  const authenticate = typeof deps.authenticate === "function" ? deps.authenticate : () => null;
  const getConversation = typeof deps.getConversation === "function" ? deps.getConversation : () => null;
  const isConversationMember = typeof deps.isConversationMember === "function"
    ? deps.isConversationMember
    : () => false;
  const getCachedOp = typeof deps.getCachedOp === "function" ? deps.getCachedOp : () => null;
  const cacheOp = typeof deps.cacheOp === "function" ? deps.cacheOp : () => {};
  const broadcast = typeof deps.broadcast === "function" ? deps.broadcast : () => {};

  async function emitDocumentUpdated(userId, document) {
    try {
      await broadcast(userId, {
        type: "memory.document_updated",
        target: document.target,
        botId: document.botId,
        revision: document.revision,
        deletedAt: document.deletedAt
      });
    } catch {
      // Broadcast is a transient hint; the durable document is authoritative.
    }
  }

  async function withIdempotency(userId, body, operation) {
    const clientOpId = String(body?.clientOpId || "");
    if (clientOpId) {
      const cached = await getCachedOp(userId, clientOpId);
      if (cached) return response(Number(cached.statusCode) || 200, cached.result);
    }
    const result = await operation();
    if (clientOpId) {
      await cacheOp(userId, clientOpId, { result: result.body, statusCode: result.status });
    }
    return result;
  }

  async function handleList(request, userId) {
    const result = store.listDocuments(userId, {
      since: queryValue(request.query, "since") || "",
      limit: queryValue(request.query, "limit")
    });
    return response(200, { ok: true, ...result });
  }

  async function handlePush(request, userId) {
    const body = request.body && typeof request.body === "object" ? request.body : {};
    return withIdempotency(userId, body, async () => {
      const result = store.pushDocuments(userId, body.documents);
      for (const accepted of result.accepted) {
        if (!accepted.noOp) await emitDocumentUpdated(userId, accepted.document);
      }
      return response(200, { ok: result.errors.length === 0, ...result });
    });
  }

  async function handleMutate(request, userId) {
    const body = request.body && typeof request.body === "object" ? request.body : {};
    return withIdempotency(userId, body, async () => {
      const conversationId = String(body.conversationId || "");
      if (!conversationId) return errorResponse(400, "conversation_id_required");
      const conversation = await getConversation(conversationId);
      if (!conversation) return errorResponse(404, "conversation_not_found");
      if (!await isConversationMember(conversationId, userId)) {
        return errorResponse(403, "conversation_forbidden");
      }

      const decorations = parseDecorations(conversation.decorations);
      if (decorations.memoryMode !== "mia") return errorResponse(409, "memory_mode_native");
      const botId = String(decorations.botId || conversation.botId || "");
      if (!botId) return errorResponse(409, "bot_identity_required");
      if (body.botId != null && String(body.botId) !== botId) {
        return errorResponse(409, "bot_identity_mismatch");
      }

      const result = store.mutate(userId, botId, {
        action: body.action,
        target: "memory",
        oldText: body.oldText,
        content: body.content
      });
      if (result.success && !result.noOp) {
        const document = store.getDocument(userId, {
          target: result.target,
          botId: result.target === "memory" ? botId : ""
        });
        await emitDocumentUpdated(userId, document);
      }
      return response(200, result);
    });
  }

  async function handle(request = {}) {
    const key = `${String(request.method || "GET").toUpperCase()} ${String(request.pathname || "")}`;
    if (!ROUTES.has(key)) return { handled: false };

    const auth = await authenticate(request);
    const userId = authUserId(auth);
    if (!userId) return errorResponse(401, "unauthorized");

    try {
      if (key === "GET /api/me/memory-documents") return await handleList(request, userId);
      if (key === "POST /api/me/memory-documents/push") return await handlePush(request, userId);
      return await handleMutate(request, userId);
    } catch (error) {
      if (error instanceof MemoryDocumentStoreError) {
        return errorResponse(error.status || 400, error.code);
      }
      return errorResponse(500, "memory_document_internal_error");
    }
  }

  return { handle };
}

module.exports = { createMemoryDocumentsApi };
