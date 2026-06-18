"use strict";

const AGENT_FIRE_MODE = "agent";
const DELIVER_FIRE_MODE = "deliver";

function rawFireMode(input = {}) {
  return String(input.fireMode || input.fire_mode || "").trim().toLowerCase();
}

function deliveryTextForTask(input = {}) {
  return String(input.deliveryText || input.delivery_text || "").trim();
}

function normalizeFireMode(input = {}) {
  const raw = rawFireMode(input);
  if (raw === DELIVER_FIRE_MODE) return DELIVER_FIRE_MODE;
  if (raw === AGENT_FIRE_MODE) return AGENT_FIRE_MODE;
  return deliveryTextForTask(input) ? DELIVER_FIRE_MODE : AGENT_FIRE_MODE;
}

function assertValidFireMode(input = {}) {
  const raw = rawFireMode(input);
  if (raw && raw !== DELIVER_FIRE_MODE && raw !== AGENT_FIRE_MODE) {
    throw new Error("fireMode must be 'agent' or 'deliver'");
  }
}

function taskPromptForStorage(input = {}) {
  return String(input.prompt || "").trim() || deliveryTextForTask(input);
}

function isDirectDeliveryTask(task = {}) {
  return normalizeFireMode(task) === DELIVER_FIRE_MODE && Boolean(deliveryTextForTask(task));
}

module.exports = {
  AGENT_FIRE_MODE,
  DELIVER_FIRE_MODE,
  assertValidFireMode,
  deliveryTextForTask,
  isDirectDeliveryTask,
  normalizeFireMode,
  taskPromptForStorage
};
