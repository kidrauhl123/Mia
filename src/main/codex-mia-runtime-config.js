const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CODEX_MIA_MODEL_CATALOG = "mia-codex-model-catalog.json";

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function codexMiaModelCatalog(model = "mia-auto") {
  const slug = String(model || "mia-auto").trim() || "mia-auto";
  const displayName = !slug || slug === "mia-auto" || slug === "mia-default" ? "Auto" : slug;
  return {
    models: [
      {
        slug,
        display_name: displayName,
        description: displayName,
        base_instructions: "You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals.",
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "none", description: "Disable Thinking" },
          { effort: "low", description: "Fast responses with lighter reasoning" },
          { effort: "medium", description: "Balanced responses" },
          { effort: "high", description: "Enabled Thinking" }
        ],
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: 1000,
        additional_speed_tiers: [],
        service_tiers: [],
        availability_nux: null,
        upgrade: null,
        supports_reasoning_summaries: true,
        default_reasoning_summary: "none",
        support_verbosity: false,
        truncation_policy: { mode: "bytes", limit: 10000 },
        supports_parallel_tool_calls: false,
        supports_image_detail_original: false,
        context_window: 262144,
        max_context_window: 262144,
        effective_context_window_percent: 95,
        experimental_supported_tools: [],
        input_modalities: ["text"],
        supports_search_tool: false
      }
    ]
  };
}

function writeCodexMiaModelCatalog(catalogPath, model = "mia-auto") {
  const target = String(catalogPath || "").trim();
  if (!target) return "";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(codexMiaModelCatalog(model), null, 2) + "\n", "utf8");
  return target;
}

function codexPermissionConfig(value) {
  const id = String(value || "default").trim();
  if (id === ":read-only") return { permissionProfile: ":read-only", sandboxMode: "read-only", approvalPolicy: "never" };
  if (id === ":workspace") return { permissionProfile: ":workspace", sandboxMode: "workspace-write", approvalPolicy: "never" };
  if (id === ":danger-full-access") return { permissionProfile: ":danger-full-access", sandboxMode: "danger-full-access", approvalPolicy: "never" };
  if (id === "acceptEdits") return { sandboxMode: "workspace-write", approvalPolicy: "on-request" };
  if (id === "bypassPermissions" || id === "yolo" || id === "off" || id === "never") {
    return { sandboxMode: "danger-full-access", approvalPolicy: "never" };
  }
  if (id === "readOnly") return { sandboxMode: "read-only", approvalPolicy: "never" };
  return { sandboxMode: "workspace-write", approvalPolicy: "untrusted" };
}

function codexMiaSessionConfig(session = {}, options = {}) {
  const baseUrl = String(session.baseUrl || "").trim().replace(/\/+$/, "");
  const model = String(session.model || "").trim();
  const modelCatalogJson = String(options.modelCatalogJson || "").trim();
  const permissionMode = String(options.permissionMode || options.permission_mode || "").trim();
  const permission = permissionMode ? codexPermissionConfig(permissionMode) : null;
  return {
    ...(model ? { model } : {}),
    model_provider: "custom",
    ...(modelCatalogJson ? { model_catalog_json: modelCatalogJson } : {}),
    ...(permission?.approvalPolicy ? { approval_policy: permission.approvalPolicy } : {}),
    ...(permission?.sandboxMode ? { sandbox_mode: permission.sandboxMode } : {}),
    disable_response_storage: true,
    model_providers: {
      custom: {
        name: "Mia",
        base_url: baseUrl,
        wire_api: "responses",
        env_key: "CODEX_API_KEY",
        requires_openai_auth: false
      }
    }
  };
}

function codexMiaSessionConfigOverrides(session = {}, options = {}) {
  const config = codexMiaSessionConfig(session, options);
  const custom = config.model_providers.custom;
  return [
    ...(config.model ? [`model=${tomlString(config.model)}`] : []),
    `model_provider=${tomlString(config.model_provider)}`,
    ...(config.model_catalog_json ? [`model_catalog_json=${tomlString(config.model_catalog_json)}`] : []),
    ...(config.approval_policy ? [`approval_policy=${tomlString(config.approval_policy)}`] : []),
    ...(config.sandbox_mode ? [`sandbox_mode=${tomlString(config.sandbox_mode)}`] : []),
    `disable_response_storage=true`,
    `model_providers.custom.name=${tomlString(custom.name)}`,
    `model_providers.custom.base_url=${tomlString(custom.base_url)}`,
    `model_providers.custom.wire_api=${tomlString(custom.wire_api)}`,
    `model_providers.custom.env_key=${tomlString(custom.env_key)}`,
    `model_providers.custom.requires_openai_auth=false`
  ];
}

module.exports = {
  DEFAULT_CODEX_MIA_MODEL_CATALOG,
  codexPermissionConfig,
  codexMiaModelCatalog,
  codexMiaSessionConfig,
  codexMiaSessionConfigOverrides,
  writeCodexMiaModelCatalog
};
