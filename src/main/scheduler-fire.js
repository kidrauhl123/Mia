// src/main/scheduler-fire.js
const crypto = require("node:crypto");

function safeRecordRun(store, taskId, run) {
  try {
    return store.recordRun(taskId, run);
  } catch (e) {
    if (/task not found/i.test(String(e?.message))) return null;
    throw e;
  }
}

function createFireRunner({ store, runRemoteChatRequest, emit, logger = console }) {
  const inflight = new Set();

  async function fire(task) {
    if (inflight.has(task.id)) {
      const run = safeRecordRun(store, task.id, {
        firedAt: Date.now(),
        finishedAt: Date.now(),
        status: "skipped",
        error: "previous run still in progress"
      });
      return run;
    }
    inflight.add(task.id);
    const runId = "r-" + crypto.randomBytes(6).toString("hex");
    const firedAt = Date.now();
    const conversationId = task.conversationId || task.sessionId;
    emit("started", { taskId: task.id, runId, conversationId });
    try {
      const result = await runRemoteChatRequest({
        fellowKey: task.fellowId,
        conversationId,
        text: task.prompt,
        displayText: task.prompt,
        // Run independently of the interactive single-flight abort controller so
        // foreground/web chat (or an overlapping task) can't abort this run.
        background: true,
        meta: { taskId: task.id, taskRunId: runId, firedAt }
      });
      // Identify the assistant reply returned by the remote run.
      const messages = result?.session?.messages || [];
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      const outputMessageId = result?.assistantMessageId || lastAssistant?.id || null;
      // Persist the reply text on the run itself. The task store is written only
      // by the daemon, so this copy is race-free and does not depend on local
      // conversation persistence.
      const outputText = String(lastAssistant?.content || "");
      const run = safeRecordRun(store, task.id, {
        id: runId,
        firedAt,
        finishedAt: Date.now(),
        status: "ok",
        outputMessageId,
        outputText
      });
      emit("finished", {
        taskId: task.id,
        runId: run?.id || runId,
        conversationId,
        fellowId: task.fellowId,
        messageId: outputMessageId,
        outputText,
        createdAt: lastAssistant?.createdAt || new Date(firedAt).toISOString(),
        status: "ok"
      });
      return run;
    } catch (e) {
      logger.error?.("[scheduler-fire] task failed", task.id, e);
      const run = safeRecordRun(store, task.id, {
        id: runId,
        firedAt,
        finishedAt: Date.now(),
        status: "failed",
        error: String(e?.message || e)
      });
      emit("failed", {
        taskId: task.id,
        runId: run?.id || runId,
        conversationId,
        error: run?.error || String(e?.message || e)
      });
      return run;
    } finally {
      inflight.delete(task.id);
    }
  }
  return { fire };
}

module.exports = { createFireRunner, safeRecordRun };
