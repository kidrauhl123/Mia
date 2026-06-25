"use strict";

const { normalizeCoreMcpRecord } = require("./records.js");

const BUILTIN_MODES = Object.freeze(["native", "managed"]);

const BUILTIN_MCP_TEMPLATES = Object.freeze([
  {
    id: "xiaohongshu",
    name: "小红书 MCP",
    nativeName: "xiaohongshu",
    description: "Mia 管理的小红书本地 MCP，用于搜索、读取和发布相关小红书工作流。",
    category: "内容平台",
    managementMode: "managed",
    homepage: "https://github.com/xpzouying/xiaohongshu-mcp",
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp", headers: {} },
    requiredInputs: [],
    managedRuntime: {
      connectorId: "xiaohongshu",
      endpoint: "http://127.0.0.1:18060/mcp",
      installDir: "",
      expectedToolCount: 13,
      state: "not_installed",
      lastAction: ""
    },
    connectionWizard: {
      state: "needs_managed_action",
      nextAction: "install",
      message: "Mia 将安装或定位本地小红书 MCP，完成登录后启动并检测连接。",
      missingRequiredInputs: [],
      actions: [
        { id: "install", label: "安装组件" },
        { id: "login", label: "打开登录" },
        { id: "start", label: "启动服务" },
        { id: "test", label: "检测并启用" }
      ]
    }
  },
  {
    id: "playwright",
    name: "Playwright MCP",
    nativeName: "playwright",
    description: "浏览器自动化、截图、点击、输入和页面验证。",
    category: "浏览器自动化",
    managementMode: "native",
    transport: { type: "stdio", command: "npx", args: ["-y", "@executeautomation/playwright-mcp-server"], env: {} },
    requiredInputs: []
  },
  {
    id: "context7",
    name: "Context7 MCP",
    nativeName: "context7",
    description: "为编程 Agent 提供库文档和版本化代码示例。",
    category: "开发",
    managementMode: "native",
    transport: { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp@latest"], env: {} },
    requiredInputs: []
  },
  {
    id: "github",
    name: "GitHub MCP",
    nativeName: "github",
    description: "读取仓库、issue 和 pull request。",
    category: "开发",
    managementMode: "native",
    transport: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: {} },
    requiredInputs: [
      { key: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "GitHub Personal Access Token", secret: true, target: "env", required: true }
    ]
  },
  {
    id: "tavily",
    name: "Tavily MCP",
    nativeName: "tavily",
    description: "联网搜索和网页检索。",
    category: "搜索",
    managementMode: "native",
    transport: { type: "stdio", command: "npx", args: ["-y", "tavily-mcp@latest"], env: {} },
    requiredInputs: [
      { key: "TAVILY_API_KEY", label: "Tavily API Key", secret: true, target: "env", required: true }
    ]
  },
  {
    id: "firecrawl",
    name: "Firecrawl MCP",
    nativeName: "firecrawl",
    description: "网页抓取、结构化提取和站点爬取。",
    category: "网页抓取",
    managementMode: "native",
    transport: { type: "stdio", command: "npx", args: ["-y", "firecrawl-mcp@latest"], env: {} },
    requiredInputs: [
      { key: "FIRECRAWL_API_KEY", label: "Firecrawl API Key", secret: true, target: "env", required: true }
    ]
  }
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function builtinMcpTemplates() {
  return BUILTIN_MCP_TEMPLATES.map((template) => clone(template));
}

function builtinMcpTemplateById(id) {
  const needle = String(id || "").trim();
  const template = BUILTIN_MCP_TEMPLATES.find((item) => item.id === needle);
  return template ? clone(template) : null;
}

function inputValue(values = {}, key = "") {
  if (Object.prototype.hasOwnProperty.call(values, key)) return String(values[key] || "").trim();
  if (values.env && Object.prototype.hasOwnProperty.call(values.env, key)) return String(values.env[key] || "").trim();
  return "";
}

function materializeTransport(template, values = {}) {
  const transport = clone(template.transport || {});
  if (transport.type === "stdio") {
    transport.env = { ...(transport.env || {}) };
    for (const field of template.requiredInputs || []) {
      if (field.target === "env") transport.env[field.key] = inputValue(values, field.key);
    }
  }
  return transport;
}

function wizardForTemplate(template, missingRequiredInputs) {
  if (template.managementMode === "managed") {
    return clone(template.connectionWizard);
  }
  return {
    state: missingRequiredInputs.length ? "missing_required_inputs" : "ready_to_test",
    nextAction: missingRequiredInputs.length ? "enter_required_inputs" : "test",
    message: missingRequiredInputs.length ? "填写必填字段后，Mia 会检测连接并启用。" : "Mia 将检测连接，成功后启用到新对话。",
    missingRequiredInputs,
    actions: [{ id: "test", label: "检测并启用" }]
  };
}

function materializeBuiltinMcpRecord(template, values = {}, options = {}) {
  if (!template || !BUILTIN_MODES.includes(template.managementMode)) {
    throw new Error("Unsupported built-in MCP template.");
  }
  const requiredInputs = Array.isArray(template.requiredInputs) ? template.requiredInputs : [];
  const missingRequiredInputs = requiredInputs
    .filter((field) => field.required !== false && !inputValue(values, field.key))
    .map((field) => field.key);
  const record = normalizeCoreMcpRecord({
    id: values.id,
    name: values.name || template.name,
    nativeName: values.nativeName || template.nativeName || template.id,
    description: template.description,
    registryId: template.id,
    source: "marketplace",
    builtin: false,
    enabled: false,
    status: missingRequiredInputs.length ? "configuration_required" : "disconnected",
    managementMode: template.managementMode,
    requiredInputs,
    connectionWizard: wizardForTemplate(template, missingRequiredInputs),
    managedRuntime: template.managedRuntime || {},
    homepage: template.homepage || "",
    expectedToolCount: template.managedRuntime?.expectedToolCount || 0,
    transport: materializeTransport(template, values)
  }, options);
  if (!record) throw new Error("Built-in MCP template produced an invalid record.");
  return { record, missingRequiredInputs };
}

module.exports = {
  builtinMcpTemplates,
  builtinMcpTemplateById,
  materializeBuiltinMcpRecord
};
