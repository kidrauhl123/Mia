"use strict";

function normalizeNativeContextMode(value = "") {
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (!raw || ["auto", "default"].includes(raw)) return "auto";
  if (["mcp", "tool", "tools", "snapshot", "context-snapshot", "native"].includes(raw)) return "mcp";
  if (["none", "off", "disabled", "never"].includes(raw)) return "none";
  if (["prompt", "inject", "injection", "legacy", "full"].includes(raw)) return "prompt";
  return "auto";
}

function nativeContextModeFromConfig(bot = {}, runtimeConfig = null, prefix = "") {
  const botConfig = bot?.engineConfig || bot?.engine_config || {};
  const runtime = runtimeConfig && typeof runtimeConfig === "object" ? runtimeConfig : {};
  const cap = (text = "") => text ? text[0].toUpperCase() + text.slice(1) : "";
  const scoped = prefix ? [
    `${prefix}NativeContextMode`,
    `${prefix}_native_context_mode`,
    `${prefix}ContextMode`,
    `${prefix}_context_mode`
  ] : [];
  const values = [
    ...scoped.map((key) => runtime[key]),
    runtime.nativeContextMode,
    runtime.native_context_mode,
    runtime.contextMode,
    runtime.context_mode,
    ...scoped.map((key) => botConfig[key]),
    botConfig.nativeContextMode,
    botConfig.native_context_mode,
    botConfig.contextMode,
    botConfig.context_mode
  ];
  const engineName = cap(prefix);
  if (engineName && runtime[`${engineName}NativeContextMode`]) values.unshift(runtime[`${engineName}NativeContextMode`]);
  if (engineName && botConfig[`${engineName}NativeContextMode`]) values.unshift(botConfig[`${engineName}NativeContextMode`]);
  const selected = values.find((value) => String(value || "").trim());
  return normalizeNativeContextMode(selected);
}

function selectNativeContextMode({ requestedMode = "", mcpAvailable = false } = {}) {
  const mode = normalizeNativeContextMode(requestedMode);
  if (mode === "auto") return mcpAvailable ? "mcp" : "prompt";
  return mode;
}

function contextSnapshotInstruction({ engine = "", botId = "", sessionId = "" } = {}) {
  const lines = [
    "## Mia Scoped Context",
    "Use the built-in `mia-app` MCP tool `context_snapshot` when you need Mia persona or memory for this turn.",
    "The tool is scoped by Mia to the current bot and conversation session. Do not reuse persona, memory, or session history from any other bot/session."
  ];
  if (engine) lines.push(`engine: ${String(engine)}`);
  if (botId) lines.push(`bot: ${String(botId)}`);
  if (sessionId) lines.push(`session: ${String(sessionId)}`);
  return lines.join("\n");
}

module.exports = {
  contextSnapshotInstruction,
  nativeContextModeFromConfig,
  normalizeNativeContextMode,
  selectNativeContextMode
};
