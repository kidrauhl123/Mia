"use strict";

const { CloudEvent } = require("../../shared/cloud-events.js");
const { buildBotInvocation } = require("./bot-invocation.js");

function createMainBotRuntimeDispatcher({
  shouldHandle = () => true,
  currentDeviceId = () => "",
  listBots = () => [],
  localBotResponder,
  log = () => {}
} = {}) {
  async function canHandle() {
    // shouldHandle may probe daemon reachability, so it can be async.
    return typeof shouldHandle === "function" ? Boolean(await shouldHandle()) : true;
  }

  async function handleBotInvocationRequested(message = {}) {
    if (!(await canHandle())) return false;
    const runtimeConfig = message.runtimeConfig && typeof message.runtimeConfig === "object" ? message.runtimeConfig : {};
    const wantedDeviceId = String(message.targetDeviceId || runtimeConfig.deviceId || runtimeConfig.targetDeviceId || "").trim();
    const ownDeviceId = String(typeof currentDeviceId === "function" ? currentDeviceId() : "").trim();
    if (!wantedDeviceId) {
      log("Ignoring desktop bot invocation without target device.");
      return false;
    }
    if (!ownDeviceId || wantedDeviceId !== ownDeviceId) return false;
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
