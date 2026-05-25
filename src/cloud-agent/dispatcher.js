const { parseAttachmentsFromMessage } = require("./attachment-materializer.js");

function requireDep(deps, key) {
  if (!deps || !deps[key]) throw new Error(`${key} dependency is required`);
  return deps[key];
}

function messageRole(row) {
  if (row.sender_kind === "fellow") return "assistant";
  if (row.sender_kind === "system") return "system";
  return "user";
}

function createCloudAgentDispatcher(deps = {}) {
  const socialStore = requireDep(deps, "socialStore");
  const messagesStore = requireDep(deps, "messagesStore");
  const fellowsStore = requireDep(deps, "fellowsStore");
  const runtimeBindingsStore = requireDep(deps, "runtimeBindingsStore");
  const cloudAgentRunsStore = requireDep(deps, "cloudAgentRunsStore");
  const workerManager = requireDep(deps, "workerManager");
  const hermesRunsClient = requireDep(deps, "hermesRunsClient");
  const attachmentMaterializer = deps.attachmentMaterializer || null;
  const broadcastPersistedEvent = typeof deps.broadcastPersistedEvent === "function"
    ? deps.broadcastPersistedEvent
    : () => {};
  const broadcastTransientEvent = typeof deps.broadcastTransientEvent === "function"
    ? deps.broadcastTransientEvent
    : () => {};
  const pending = new Set();

  function conversationHistory(roomId) {
    return messagesStore.listMessagesSince(roomId, 0, 200).map((row) => ({
      role: messageRole(row),
      content: row.body_md || ""
    }));
  }

  async function runUserMessage(args = {}) {
    const userId = String(args.userId || "").trim();
    const roomId = String(args.roomId || "").trim();
    const message = args.message || {};
    if (!userId || !roomId || !message.id) return null;
    if (message.sender_kind && message.sender_kind !== "user") return null;

    const room = socialStore.getRoom(roomId);
    if (!room || room.type !== "fellow") return null;
    if (room.decorations?.runtimeKind !== "cloud-hermes") return null;
    const fellowMember = socialStore.listRoomMembers(roomId)
      .find((member) => member.member_kind === "fellow" && member.owner_id === userId);
    if (!fellowMember) return null;

    const fellowId = fellowMember.member_ref;
    const binding = runtimeBindingsStore.getEnabledBinding(userId, fellowId, "cloud-hermes");
    if (!binding) return null;
    const runtimeConfig = binding.config || {};
    const fellow = fellowsStore.getFellow(userId, fellowId) || { id: fellowId, name: fellowId };

    const run = cloudAgentRunsStore.createRun({
      userId,
      fellowId,
      roomId,
      triggerMessageId: message.id
    });

    try {
      const worker = await workerManager.ensureWorker(userId);
      const materialized = attachmentMaterializer
        ? attachmentMaterializer.materialize({
          userId,
          workerPaths: worker.paths || {},
          runId: run.id,
          text: message.body_md || "",
          attachments: parseAttachmentsFromMessage(message)
        })
        : { attachments: [], input: message.body_md || "" };
      const result = await hermesRunsClient.runChat({
        baseUrl: worker.baseUrl,
        apiKey: worker.apiKey,
        userId,
        fellow,
        roomId,
        model: runtimeConfig.model || "hermes-agent",
        effortLevel: runtimeConfig.effortLevel || "medium",
        permissionMode: runtimeConfig.permissionMode || "ask",
        input: materialized.input || message.body_md || "",
        attachments: materialized.attachments || [],
        conversationHistory: conversationHistory(roomId),
        onRunCreated(hermesRunId) {
          cloudAgentRunsStore.markRunning(run.id, hermesRunId || "");
          broadcastTransientEvent(userId, {
            type: "cloud_agent_run_started",
            runId: run.id,
            hermesRunId,
            roomId,
            fellowId,
            triggerMessageId: message.id
          });
        },
        onEvent(event) {
          broadcastTransientEvent(userId, {
            type: "cloud_agent_run_event",
            runId: run.id,
            roomId,
            fellowId,
            event
          });
        }
      });
      const replyAttachments = attachmentMaterializer?.archiveGeneratedAttachments
        ? attachmentMaterializer.archiveGeneratedAttachments({
          userId,
          workerPaths: worker.paths || {},
          result
        })
        : [];
      if (result.runId) cloudAgentRunsStore.markRunning(run.id, result.runId);
      const reply = messagesStore.appendMessage({
        roomId,
        senderKind: "fellow",
        senderRef: fellowId,
        senderOwnerId: userId,
        bodyMd: result.content || "",
        attachments: replyAttachments.length ? replyAttachments : null,
        status: "complete"
      });
      cloudAgentRunsStore.markComplete(run.id);
      for (const member of socialStore.listRoomMembers(roomId)) {
        if (member.member_kind === "user") {
          broadcastPersistedEvent(member.member_ref, { type: "room.message_appended", roomId, message: reply });
        }
      }
      return reply;
    } catch (error) {
      cloudAgentRunsStore.markError(run.id, error);
      return null;
    }
  }

  function handleUserMessage(args = {}) {
    const promise = runUserMessage(args);
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
    return promise;
  }

  async function idle() {
    while (pending.size) {
      await Promise.allSettled([...pending]);
    }
  }

  return { handleUserMessage, idle };
}

module.exports = { createCloudAgentDispatcher };
