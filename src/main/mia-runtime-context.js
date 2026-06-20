const MIA_RUNTIME_CONTEXT = [
  "## Mia Runtime Context",
  "",
  "Mia 是聊天式多 Agent 应用。用户正在 Mia 里和当前 Bot 对话，Bot 的回复会回到这个 Mia 会话。"
].join("\n");
const MIA_MEMORY_HEADER = "## Mia Bot Memory";

const MIA_SCHEDULED_FIRE_CONTEXT = [
  "## Mia Runtime Context",
  "",
  "Mia 是聊天式多 Agent 应用。用户正在 Mia 里和当前 Bot 对话，Bot 的回复会回到这个 Mia 会话。"
].join("\n");

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
    .replace(/## Mia Bot Memory/g, "Mia Bot Memory")
    .replace(/## Mia Bot Memory/g, "Mia Bot Memory");
}

function appendMiaMemoryBlock(base = "", memoryBlock = "") {
  const text = String(base || "").trim();
  const addition = String(memoryBlock || "").trim();
  if (!addition) return text;
  if (text.includes(`${MIA_MEMORY_HEADER}\nsource: mia`)) return text;
  return [text, addition].filter(Boolean).join("\n\n");
}

module.exports = {
  MIA_MEMORY_HEADER,
  MIA_RUNTIME_CONTEXT,
  MIA_SCHEDULED_FIRE_CONTEXT,
  appendMiaMemoryBlock,
  miaRuntimeSystemPrompt,
  sanitizeMiaMemorySpoof,
  withMiaRuntimeContext
};
