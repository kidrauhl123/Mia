(function attachAssistantTemplate(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaAssistantTemplate = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildAssistantTemplateApi() {
  "use strict";

  function text(value = "") {
    return String(value || "").trim();
  }

  function uniqueTextList(value = [], limit = 8) {
    return Array.isArray(value)
      ? [...new Set(value.map(text).filter(Boolean))].slice(0, limit)
      : [];
  }

  function assistantResponsibility(template = {}) {
    return text(template.responsibility || template.line || template.desc || template.description);
  }

  function assistantHandoffExamples(template = {}) {
    const examples = uniqueTextList(template.handoffExamples || template.handoff_examples, 6);
    if (examples.length) return examples;
    return uniqueTextList(String(template.demo || "").split(/\r?\n/).filter((line) => !/^你[:：]/.test(line)), 3);
  }

  function assistantContextBindings(template = {}) {
    return uniqueTextList(template.contextBindings || template.context_bindings, 8);
  }

  function assistantPersonaText(template = {}) {
    const base = text(template.persona || template.personaText);
    const responsibility = assistantResponsibility(template);
    const bindings = assistantContextBindings(template);
    const examples = assistantHandoffExamples(template);
    const sections = [];
    if (base) sections.push(base);
    const context = ["## Mia Assistant Template Context"];
    if (text(template.name)) context.push(`模板：${text(template.name)}`);
    if (responsibility) context.push(`职责：${responsibility}`);
    if (bindings.length) context.push(`关注线索：${bindings.join("、")}`);
    if (examples.length) {
      context.push("常见请求：");
      for (const example of examples.slice(0, 3)) context.push(`- ${example}`);
    }
    sections.push(context.join("\n"));
    return sections.join("\n\n").trim();
  }

  function assistantDescription(template = {}) {
    const responsibility = assistantResponsibility(template) || text(template.description || template.desc || template.line);
    return responsibility;
  }

  return {
    assistantResponsibility,
    assistantHandoffExamples,
    assistantPersonaText,
    assistantDescription
  };
});
