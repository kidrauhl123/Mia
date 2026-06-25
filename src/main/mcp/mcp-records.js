"use strict";

const core = require("../../core/mcp/records.js");

module.exports = {
  MASK_SENTINEL: core.MASK,
  cleanObject: core.cleanObject,
  enabledMcpRecords: core.enabledCoreMcpRecords,
  maskMcpRecord: core.publicCoreMcpRecord,
  mcpFingerprint: core.coreMcpFingerprint,
  normalizeMcpRecord: core.normalizeCoreMcpRecord,
  normalizeMcpRegistry: core.normalizeCoreMcpRegistry,
  normalizeTransport: core.normalizeTransport,
  parseMcpImportJson: core.parseCoreMcpImportJson,
  sanitizeSecretText: core.sanitizeSecretText
};
