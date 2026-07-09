"use strict";

function ensureObject(value) {
  return value && typeof value === "object" ? value : {};
}

function arrayField(value, field) {
  const object = ensureObject(value);
  return Array.isArray(object[field]) ? object[field] : [];
}

function normalizeCapabilities(value = {}) {
  const object = ensureObject(value);
  return {
    approvalModes: Array.isArray(object.approvalModes) && object.approvalModes.length
      ? object.approvalModes
      : ["ask", "yolo", "deny"],
    effortLevels: Array.isArray(object.effortLevels) && object.effortLevels.length
      ? object.effortLevels
      : ["low", "medium", "high"],
    engines: ensureObject(object.engines)
  };
}

function createEngineCatalogCoreAdapter({
  coreRequest
} = {}) {
  if (typeof coreRequest !== "function") {
    throw new Error("coreRequest dependency is required.");
  }

  async function get(route) {
    return coreRequest({ method: "GET", route });
  }

  return {
    async loadHermesModelCatalog() {
      return arrayField(await get("/api/engines/model-catalog"), "models");
    },
    async loadCodexModels() {
      return arrayField(await get("/api/engines/codex/models"), "models");
    },
    async loadEngineCapabilities() {
      return normalizeCapabilities(await get("/api/engines/capabilities"));
    },
    async loadHermesSlashCommands() {
      return arrayField(await get("/api/engines/slash-commands"), "commands");
    }
  };
}

module.exports = {
  createEngineCatalogCoreAdapter,
  normalizeCapabilities
};
