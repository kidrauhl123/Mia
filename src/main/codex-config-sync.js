const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VALID_SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const VALID_APPROVAL_POLICIES = new Set(["untrusted", "on-request", "never"]);

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function codexHomeDir({ homeDir = os.homedir } = {}) {
  return path.join(String(homeDir() || os.homedir()), ".codex");
}

function codexConfigPath(options = {}) {
  return path.join(codexHomeDir(options), "config.toml");
}

function codexConfigValuesForPermission(permission = {}) {
  const sandboxMode = VALID_SANDBOX_MODES.has(permission.sandboxMode)
    ? permission.sandboxMode
    : "workspace-write";
  const approvalPolicy = VALID_APPROVAL_POLICIES.has(permission.approvalPolicy)
    ? permission.approvalPolicy
    : "untrusted";
  return { sandboxMode, approvalPolicy };
}

function isTopLevelAssignment(line, key) {
  const trimmed = String(line || "").trimStart();
  const rest = trimmed.startsWith(key) ? trimmed.slice(key.length) : "";
  return rest.trimStart().startsWith("=");
}

function renderConfigWithTopLevelValues(content = "", values = {}) {
  const newline = String(content || "").includes("\r\n") ? "\r\n" : "\n";
  const body = String(content || "").endsWith(newline)
    ? String(content || "").slice(0, -newline.length)
    : String(content || "");
  let lines = body ? body.split(newline) : [];
  const entries = [
    ["approval_policy", values.approvalPolicy],
    ["sandbox_mode", values.sandboxMode]
  ].filter(([, value]) => value);
  const seen = new Set();

  const firstSectionIndex = lines.findIndex((line) => line.trimStart().startsWith("["));
  const topLevelEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;
  for (let index = 0; index < topLevelEnd; index += 1) {
    for (const [key, value] of entries) {
      if (isTopLevelAssignment(lines[index], key)) {
        lines[index] = `${key} = ${tomlString(value)}`;
        seen.add(key);
      }
    }
  }

  const missing = entries
    .filter(([key]) => !seen.has(key))
    .map(([key, value]) => `${key} = ${tomlString(value)}`);
  if (missing.length) {
    if (!lines.length) {
      lines = missing;
    } else if (firstSectionIndex === -1) {
      lines = [...lines, ...missing];
    } else {
      let insertAt = firstSectionIndex;
      while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt -= 1;
      lines = [
        ...lines.slice(0, insertAt),
        ...missing,
        "",
        ...lines.slice(firstSectionIndex)
      ];
    }
  }

  return `${lines.join(newline)}${newline}`;
}

function syncCodexConfigForPermission(permission = {}, options = {}) {
  const fsImpl = options.fs || fs;
  const appendLog = typeof options.appendLog === "function" ? options.appendLog : () => {};
  const configPath = options.configPath || codexConfigPath(options);
  const values = codexConfigValuesForPermission(permission);
  try {
    let content = "";
    try {
      content = fsImpl.readFileSync(configPath, "utf8");
    } catch {
      content = "";
    }
    const next = renderConfigWithTopLevelValues(content, values);
    fsImpl.mkdirSync(path.dirname(configPath), { recursive: true });
    fsImpl.writeFileSync(configPath, next, "utf8");
    return { ok: true, configPath, ...values };
  } catch (error) {
    appendLog(`Codex config sync failed: ${error?.message || error}`);
    return { ok: false, configPath, error, ...values };
  }
}

module.exports = {
  codexConfigPath,
  codexConfigValuesForPermission,
  codexHomeDir,
  renderConfigWithTopLevelValues,
  syncCodexConfigForPermission
};
