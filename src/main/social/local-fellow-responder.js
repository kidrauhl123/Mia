"use strict";

const PROCESSED_CAP = 500;

function shouldHandleLocalCloudConversationAi({ isDaemon, daemonEnabled }) {
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

// Composer "使用" chips travel with the user's cloud message (skills_json). Pull
// the selected skill ids off the triggering message so the responder can drive
// the agent with them — one source of truth, works across devices.
function activeSkillIdsFromMessage(message) {
  const raw = message && message.skills_json;
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const ids = [];
  const seen = new Set();
  for (const skill of parsed) {
    if (ids.length >= 16) break;
    // Accept only a plain string id or a { id: string } object — never coerce
    // arbitrary objects/numbers (which would stringify to junk skill ids).
    const value = typeof skill === "string" ? skill : (skill && typeof skill.id === "string" ? skill.id : "");
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function createLocalFellowResponder({ sendChat, postConversationMessageAsFellow, emitCloudEvent = () => {}, log = () => {} }) {
  const processed = new Set();
  const inFlight = new Set();

  function remember(key) {
    processed.add(key);
    if (processed.size > PROCESSED_CAP) processed.delete(processed.values().next().value);
  }

  async function postFailureMessage({ conversationId, fellowId, dedupKey, turnId, stage, error }) {
    const message = String(error?.message || error || "unknown error");
    try {
      const result = await postConversationMessageAsFellow(conversationId, {
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

  async function respond({ conversationId, fellowId, dedupKey, systemPrompt, userPrompt, turnId = null, runtimeConfig = null, activeSkillIds = [] }) {
    if (!conversationId || !fellowId || !dedupKey) return;
    if (processed.has(dedupKey)) return;
    if (inFlight.has(dedupKey)) return;
    inFlight.add(dedupKey);

    let text = "";
    const runId = runIdForDedupKey(dedupKey);
    emitCloudEvent({
      type: "cloud_agent_run_started",
      runId,
      conversationId,
      fellowId,
      triggerMessageId: triggerMessageIdForDedupKey(dedupKey)
    });
    try {
      const chatArgs = {
        fellowKey: fellowId,
        personaKey: fellowId,
        sessionId: `conversation:${conversationId}`,
        messages: [
          { role: "system", content: systemPrompt || "" },
          { role: "user", content: userPrompt || "" }
        ],
        group: true,
        utility: true,
        allowSlashCommands: false
      };
      if (runtimeConfig && typeof runtimeConfig === "object") chatArgs.runtimeConfig = runtimeConfig;
      // Composer skill chips that rode in on the triggering message: merge them
      // into this turn so the chip actually reaches the engine (sendChat folds
      // them into capabilities.enabledSkills and prepends a "use these" directive).
      if (Array.isArray(activeSkillIds) && activeSkillIds.length) chatArgs.activeSkillIds = activeSkillIds;
      const result = await sendChat(chatArgs);
      text = responseText(result);
    } catch (error) {
      log(`[local-fellow-responder] engine failed: ${error?.message || error}`);
      emitCloudEvent({
        type: "cloud_agent_run_event",
        runId,
        conversationId,
        fellowId,
        event: { type: "run.failed", error: String(error?.message || error) }
      });
      const didPostFailure = await postFailureMessage({
        conversationId,
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
        conversationId,
        fellowId,
        event: { type: "run.failed", error: "empty response" }
      });
      inFlight.delete(dedupKey);
      return;
    }

    try {
      const result = await postConversationMessageAsFellow(conversationId, {
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
        conversationId,
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
  activeSkillIdsFromMessage,
  clientOpIdForDedupKey,
  createLocalFellowResponder,
  runIdForDedupKey,
  responseText,
  shouldHandleLocalCloudConversationAi
};
