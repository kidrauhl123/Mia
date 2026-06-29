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

  function assistantSetupRequirement(template = {}) {
    return text(template.setupPrompt || template.setup_prompt || template.bestFor || template.tagline);
  }

  function assistantHandoffExamples(template = {}) {
    const examples = uniqueTextList(template.handoffExamples || template.handoff_examples, 6);
    if (examples.length) return examples;
    return uniqueTextList(String(template.demo || "").split(/\r?\n/).filter((line) => !/^你[:：]/.test(line)), 3);
  }

  function normalizeSetupField(field = {}) {
    const id = text(field.id);
    const label = text(field.label);
    if (!id || !label) return null;
    const normalizedType = text(field.type);
    const type = ["text", "textarea", "folder"].includes(normalizedType) ? normalizedType : "text";
    return {
      id,
      label,
      type,
      required: Boolean(field.required),
      placeholder: text(field.placeholder)
    };
  }

  function assistantSetupFields(template = {}) {
    const setup = template.setup && typeof template.setup === "object" ? template.setup : {};
    return (Array.isArray(setup.fields) ? setup.fields : [])
      .map(normalizeSetupField)
      .filter(Boolean)
      .slice(0, 8);
  }

  function assistantSetupSummary(template = {}, values = {}) {
    const fields = assistantSetupFields(template);
    const lines = [];
    const missingRequired = [];
    for (const field of fields) {
      const value = text(values[field.id]);
      if (value) lines.push(`${field.label}：${value}`);
      else if (field.required) missingRequired.push(field.label);
    }
    return { lines, missingRequired };
  }

  function assistantPersonaText(template = {}, values = {}) {
    const base = text(template.persona || template.personaText);
    const responsibility = assistantResponsibility(template);
    const setup = assistantSetupSummary(template, values);
    const sections = [];
    if (base) sections.push(base);
    const context = ["## Mia Assistant Template Context"];
    if (text(template.name)) context.push(`模板：${text(template.name)}`);
    if (responsibility) context.push(`长期负责：${responsibility}`);
    if (setup.lines.length) {
      context.push("已知设置：");
      for (const line of setup.lines) context.push(`- ${line}`);
    }
    if (setup.missingRequired.length) {
      context.push(`缺失设置：${setup.missingRequired.join("、")}`);
      context.push("第一次对话请先补齐缺失设置，再继续处理用户请求。");
    }
    sections.push(context.join("\n"));
    return sections.join("\n\n").trim();
  }

  function assistantDescription(template = {}, values = {}) {
    const responsibility = assistantResponsibility(template) || text(template.description || template.desc || template.line);
    const setup = assistantSetupSummary(template, values);
    if (!setup.lines.length) return responsibility;
    return `${responsibility}\n\n已设置：${setup.lines.join("；")}`.trim();
  }

  return {
    assistantResponsibility,
    assistantSetupRequirement,
    assistantHandoffExamples,
    assistantSetupFields,
    assistantSetupSummary,
    assistantPersonaText,
    assistantDescription
  };
});
