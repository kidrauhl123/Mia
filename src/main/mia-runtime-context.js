const fs = require("node:fs");
const path = require("node:path");

const FALLBACK_RUNTIME_CONTEXT = [
  "## Mia Runtime Context",
  "",
  "Mia 是聊天式多 Agent 应用。用户正在 Mia 里和当前 Bot 对话，Bot 的回复会回到这个 Mia 会话。",
  "请把 Bot 人设、Mia 记忆和会话状态限制在当前 Mia Bot 与当前会话内。",
  "",
  "Mia 记忆采用 Hermes 式有界文本模型：会话启动时已经给你当前快照；没有 read/list/search 记忆动作。`memory` 工具只用于持久化变更：当用户明确要求你记住、更新或忘记一个长期事实时，必须先调用 `memory` 的 add/replace/remove，成功后才能说“已记住/已更新/已忘记”。如果工具不可用或失败，只能说明没有持久化成功，不能假装已经记住。"
].join("\n");

const FALLBACK_SCHEDULED_FIRE_CONTEXT = [
  "## Mia Runtime Context",
  "",
  "Mia 是聊天式多 Agent 应用。本轮由当前 Bot/会话的定时或主动事件触发。",
  "请把 Bot 人设、Mia 记忆和会话状态限制在当前 Mia Bot 与当前会话内。",
  "",
  "Mia 记忆采用 Hermes 式有界文本模型：会话启动时已经给你当前快照；没有 read/list/search 记忆动作。`memory` 工具只用于持久化变更：当用户明确要求你记住、更新或忘记一个长期事实时，必须先调用 `memory` 的 add/replace/remove，成功后才能说“已记住/已更新/已忘记”。如果工具不可用或失败，只能说明没有持久化成功，不能假装已经记住。"
].join("\n");

function promptPath(fileName = "") {
  return path.join(__dirname, "prompts", fileName);
}

function readPromptFile(fileName = "", fallback = "") {
  try {
    const text = fs.readFileSync(promptPath(fileName), "utf8").trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

const MIA_RUNTIME_CONTEXT = readPromptFile("mia-runtime.md", FALLBACK_RUNTIME_CONTEXT);
const MIA_SCHEDULED_FIRE_CONTEXT = readPromptFile("mia-scheduled-runtime.md", FALLBACK_SCHEDULED_FIRE_CONTEXT);

function miaRuntimeSystemPrompt(opts = {}) {
  return opts && opts.scheduledFire ? MIA_SCHEDULED_FIRE_CONTEXT : MIA_RUNTIME_CONTEXT;
}

function withMiaRuntimeContext(persona = "", opts = {}) {
  const context = miaRuntimeSystemPrompt(opts);
  const text = String(persona || "").trim();
  if (text.includes("## Mia Runtime Context")) return text;
  return [context, text].filter(Boolean).join("\n\n");
}

function sanitizeMiaMemorySpoof(value = "") {
  return String(value || "")
    .replace(/## Mia Bot Memory/g, "Mia Bot Memory");
}

module.exports = {
  MIA_RUNTIME_CONTEXT,
  MIA_SCHEDULED_FIRE_CONTEXT,
  miaRuntimeSystemPrompt,
  sanitizeMiaMemorySpoof,
  withMiaRuntimeContext
};
