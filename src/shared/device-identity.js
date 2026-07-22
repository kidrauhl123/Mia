"use strict";

const PLACEHOLDER_DEVICE_NAMES = new Set([
  "本机",
  "本机 agent",
  "当前设备",
  "current device",
  "current-device",
  "设备",
  "目标设备",
  "mia desktop",
  "mia bridge"
]);

function compactDeviceName(value = "") {
  let text = String(value || "").trim();
  if (!text) return "";
  for (let pass = 0; pass < 2; pass += 1) {
    text = text
      .replace(/\s*(?:·|-)\s*(?:本机|在线|离线)\s*$/i, "")
      .replace(/\s*(?:·|-)?\s*Mia\s+(?:Desktop|Bridge)\s*$/i, "");
  }
  return text
    .replace(/\.local(?=\s|$)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isPlaceholderDeviceName(value = "") {
  return PLACEHOLDER_DEVICE_NAMES.has(compactDeviceName(value).toLowerCase());
}

function deviceNameFromCapabilities(capabilities = {}) {
  const input = capabilities && typeof capabilities === "object" ? capabilities : {};
  for (const key of [
    "hostname",
    "machineName",
    "machine_name",
    "computerName",
    "computer_name",
    "deviceName",
    "device_name"
  ]) {
    const candidate = compactDeviceName(input[key]);
    if (candidate && !isPlaceholderDeviceName(candidate)) return candidate;
  }
  return "";
}

function canonicalDeviceName(value = "", capabilities = {}) {
  const capabilityName = deviceNameFromCapabilities(capabilities);
  if (capabilityName) return capabilityName;
  const explicitName = compactDeviceName(value);
  return explicitName || "本机 Agent";
}

module.exports = {
  compactDeviceName,
  isPlaceholderDeviceName,
  deviceNameFromCapabilities,
  canonicalDeviceName
};
