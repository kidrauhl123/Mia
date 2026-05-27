"use strict";

const PROCESSED_CAP = 500;

function shouldHandleLocalCloudRoomAi({ isDaemon, daemonEnabled }) {
  void daemonEnabled;
  return !Boolean(isDaemon);
}

function clientOpIdForDedupKey(dedupKey) {
  const safe = String(dedupKey || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);
  return `op_fellow_reply_${safe || "unknown"}`;
}

function errorClientOpIdForDedupKey(dedupKey) {
  return clientOpIdForDedupKey(dedupKey).replace(/^op_fellow_reply_/, "op_fellow_reply_error_");
}

function responseText(result) {
  const message = result?.choices?.[0]?.message || result?.message || {};
  return String(message.content || result?.content || "").trim();
}

function runIdForDedupKey(dedupKey) {
  return `local_${clientOpIdForDedupKey(dedupKey).replace(/^op_/, "")}`;
}

function triggerMessageIdForDedupKey(dedupKey) {
  return String(dedupKey || "").split(":")[0] || "";
}

function userFacingFailureMessage(message) {
  const text = String(message || "").trim();
  if (/(quota|exhaust|RESOURCE_EXHAUSTED|429)/i.test(text)) {
    return "我这次没能生成回复：模型配额已耗尽，请稍后重试或切换模型。";
  }
  return "我这次没能生成回复：本地模型运行失败，请稍后重试或切换模型。";
}

function createLocalFellowResponder({ sendChat, postRoomMessageAsFellow, emitCloudEvent = () => {}, getPendingRoomSkills = () => [], log = () => {} }) {
  const processed = new Set();
  const inFlight = new Set();

  function remember(key) {
    processed.add(key);
    if (processed.size > PROCESSED_CAP) processed.delete(processed.values().next().value);
  }

  async function postFailureMessage({ roomId, fellowId, dedupKey, turnId, stage, error }) {
    const message = String(error?.message || error || "unknown error");
    try {
      const result = await postRoomMessageAsFellow(roomId, {
        fellowId,
        bodyMd: userFacingFailureMessage(message),
        turnId,
        errorJson: { stage, message },
        clientOpId: errorClientOpIdForDedupKey(dedupKey)
      });
      if (result && result.ok === false) throw new Error(result.error || result.message || "post failed");
      return true;
    } catch (postError) {
      log(`[local-fellow-responder] failure post failed: ${postError?.message || postError}`);
      return false;
    }
  }

  async function respond({ roomId, fellowId, dedupKey, systemPrompt, userPrompt, turnId = null, runtimeConfig = null }) {
    if (!roomId || !fellowId || !dedupKey) return;
    if (processed.has(dedupKey)) return;
    if (inFlight.has(dedupKey)) return;
    inFlight.add(dedupKey);

    let text = "";
    const runId = runIdForDedupKey(dedupKey);
    emitCloudEvent({
      type: "cloud_agent_run_started",
      runId,
      roomId,
      fellowId,
      triggerMessageId: triggerMessageIdForDedupKey(dedupKey)
    });
    try {
      const chatArgs = {
        fellowKey: fellowId,
        personaKey: fellowId,
        sessionId: `room:${roomId}`,
        messages: [
          { role: "system", content: systemPrompt || "" },
          { role: "user", content: userPrompt || "" }
        ],
        group: true,
        utility: true,
        allowSlashCommands: false
      };
      if (runtimeConfig && typeof runtimeConfig === "object") chatArgs.runtimeConfig = runtimeConfig;
      // Composer skill chips: peek the active skill ids the renderer published
      // for this room and merge them into this turn so the chip actually reaches
      // the engine (sendChat folds them into capabilities.enabledSkills). We do
      // not clear them here — the chip is sticky while attached, so every turn
      // loads it and a failed turn doesn't drop it; the renderer clears by
      // sending without chips.
      const pendingSkillIds = getPendingRoomSkills(roomId);
      if (Array.isArray(pendingSkillIds) && pendingSkillIds.length) chatArgs.activeSkillIds = pendingSkillIds;
      const result = await sendChat(chatArgs);
      text = responseText(result);
    } catch (error) {
      log(`[local-fellow-responder] engine failed: ${error?.message || error}`);
      emitCloudEvent({
        type: "cloud_agent_run_event",
        runId,
        roomId,
        fellowId,
        event: { type: "run.failed", error: String(error?.message || error) }
      });
      const didPostFailure = await postFailureMessage({
        roomId,
        fellowId,
        dedupKey,
        turnId,
        stage: "engine",
        error
      });
      if (didPostFailure) remember(dedupKey);
      inFlight.delete(dedupKey);
      return didPostFailure;
    }
    if (!text) {
      emitCloudEvent({
        type: "cloud_agent_run_event",
        runId,
        roomId,
        fellowId,
        event: { type: "run.failed", error: "empty response" }
      });
      inFlight.delete(dedupKey);
      return;
    }

    try {
      const result = await postRoomMessageAsFellow(roomId, {
        fellowId,
        bodyMd: text,
        turnId,
        clientOpId: clientOpIdForDedupKey(dedupKey)
      });
      if (result && result.ok === false) throw new Error(result.error || result.message || "post failed");
      remember(dedupKey);
      inFlight.delete(dedupKey);
      return true;
    } catch (error) {
      log(`[local-fellow-responder] post failed: ${error?.message || error}`);
      emitCloudEvent({
        type: "cloud_agent_run_event",
        runId,
        roomId,
        fellowId,
        event: { type: "run.failed", error: String(error?.message || error) }
      });
      inFlight.delete(dedupKey);
      return false;
    }
  }

  return { respond };
}

module.exports = {
  clientOpIdForDedupKey,
  createLocalFellowResponder,
  runIdForDedupKey,
  responseText,
  shouldHandleLocalCloudRoomAi
};
