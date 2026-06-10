"use strict";

const { CloudEvent } = require("../../shared/cloud-events.js");
const { buildBotInvocation } = require("./bot-invocation.js");

function createMainBotRuntimeDispatcher({
  shouldHandle = () => true,
  currentDeviceId = () => "",
  currentDeviceIds = null,
  listBots = () => [],
  localBotResponder,
  log = () => {}
} = {}) {
  function canHandle() {
    return typeof shouldHandle === "function" ? Boolean(shouldHandle()) : true;
  }

  async function handleBotInvocationRequested(message = {}) {
    if (!canHandle()) return false;
    const runtimeConfig = message.runtimeConfig && typeof message.runtimeConfig === "object" ? message.runtimeConfig : {};
    const wantedDeviceId = String(message.targetDeviceId || runtimeConfig.deviceId || runtimeConfig.targetDeviceId || "").trim();
    const ownDeviceIds = typeof currentDeviceIds === "function"
      ? currentDeviceIds()
      : [typeof currentDeviceId === "function" ? currentDeviceId() : ""];
    const ownDeviceIdSet = new Set((Array.isArray(ownDeviceIds) ? ownDeviceIds : [ownDeviceIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean));
    if (wantedDeviceId && ownDeviceIdSet.size && !ownDeviceIdSet.has(wantedDeviceId)) return false;
    if (!localBotResponder || typeof localBotResponder.respond !== "function") return false;
    const args = buildBotInvocation(message, listBots());
    if (!args) return false;
    return Boolean(await localBotResponder.respond(args));
  }

  async function handleCloudEvent(message = {}) {
    if (message.type !== CloudEvent.ConversationBotInvocationRequested) return false;
    try {
      return await handleBotInvocationRequested(message);
    } catch (error) {
      log(`Cloud bot invocation failed: ${error?.message || error}`);
      return false;
    }
  }

  return { handleBotInvocationRequested, handleCloudEvent };
}

module.exports = { createMainBotRuntimeDispatcher };
