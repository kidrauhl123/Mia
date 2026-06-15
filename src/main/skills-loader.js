// Skills loader / library module (main process)
// Extracted from src/main.js. Owns the entire local-skill discovery
// pipeline: parsing SKILL.md frontmatter, walking plugin roots,
// enumerating extensions/plugins/connectors, merging with the Hermes
// engine's reported enable/disable state, and the CRUD surface
// (read/delete/openDirectory/install + the slash-command expander).
//
// Pattern matches src/main/codex-chat-adapter.js: CommonJS module
// exporting createSkillsLoader({...deps}) — main.js wires runtime
// references (runtimePaths, engineState, apiKey, etc.) at startup.

const fs = require("node:fs");
const path = require("node:path");
const { shell } = require("electron");
const AdmZip = require("adm-zip");
const { botCapabilitiesWithPresetDefaults } = require("../shared/bot-identity.js");
const { isSafeId, isSafeEntryName, assertInside, MAX_FILES, MAX_UNCOMPRESSED_BYTES } = require("../shared/skill-safety.js");

function cleanYamlScalar(value) {
  return String(value || "").trim().replace(/^['"]|['"]$/g, "");
}

function createSkillsLoader(deps = {}) {
  const {
    runtimePaths,
    readJson,
    officialLibraryManifestPath,
    resolveOfficialLibraryRoot,
    // `getEngineState` is an accessor because main.js reassigns the
    // engineState object whenever the Hermes process restarts; a captured
    // reference would go stale and `fetchHermesSkillsCatalog` would either
    // skip the probe forever or hit the wrong baseUrl.
    getEngineState,
    apiKey,
    appendEngineLog,
    isChildPath,
  } = deps;

  function parseSkillMarkdown(filePath, rootInfo) {
    const raw = fs.readFileSync(filePath, "utf8");
    const rel = path.relative(rootInfo.root, path.dirname(filePath));
    const parts = rel.split(path.sep).filter(Boolean);
    const fallbackName = parts[parts.length - 1] || path.basename(path.dirname(filePath));
    const rawCategory = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    const category = rawCategory === ".system" ? "system" : (rawCategory || "uncategorized");
    const meta = {};
    let body = raw;
    let frontmatter = "";
    if (raw.startsWith("---")) {
      const lines = raw.split(/\r?\n/);
      const end = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line));
      if (end > 0) {
        frontmatter = lines.slice(1, end).join("\n");
        body = lines.slice(end + 1).join("\n");
        for (const line of lines.slice(1, end)) {
          const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
          if (match) meta[match[1]] = cleanYamlScalar(match[2]);
        }
      }
    }
    const tagMatch = frontmatter.match(/tags:\s*\[([^\]]+)\]/);
    const tags = tagMatch
      ? tagMatch[1].split(",").map((item) => cleanYamlScalar(item)).filter(Boolean).slice(0, 8)
      : [];
    const firstHeading = body.match(/^#\s+(.+)$/m)?.[1]?.trim() || "";
    const paragraphs = body
      .replace(/^#.+$/gm, "")
      .split(/\n\s*\n/)
      .map((item) => item.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const description = meta.description || paragraphs[0] || "";
    const id = `${rootInfo.idPrefix || rootInfo.source}:${rel}`;
    return {
      id,
      name: meta.name || fallbackName,
      title: firstHeading || meta.name || fallbackName,
      description: description.slice(0, 520),
      version: meta.version || "",
      category,
      tags,
      source: rootInfo.source,
      sourceLabel: rootInfo.label,
      relPath: rel,
      filePath,
      bodyPreview: body.trim().slice(0, 1200),
      bodyLength: body.length
    };
  }

  function findSkillFiles(root, maxDepth = 8) {
    const files = [];
    function walk(dir, depth) {
      if (depth > maxDepth) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === "SKILL.md") {
          files.push(full);
        } else if (entry.isDirectory() && !["node_modules", ".git", "__pycache__"].includes(entry.name)) {
          walk(full, depth + 1);
        }
      }
    }
    walk(root, 0);
    return files;
  }

  function countDirectoryFiles(dir, predicate = () => true, maxDepth = 2) {
    let count = 0;
    function walk(current, depth) {
      if (depth > maxDepth) return;
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile() && predicate(full, entry)) count += 1;
      }
    }
    walk(dir, 0);
    return count;
  }

  function readMarketMarker(skillDir) {
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(skillDir, ".mia-market.json"), "utf8"));
      return marker && typeof marker === "object" ? marker : null;
    } catch {
      return null;
    }
  }

  function readMarketMarkerForSkill(filePath, sourceRoot) {
    const root = path.resolve(sourceRoot);
    let current = path.resolve(path.dirname(filePath));
    while (current === root || current.startsWith(root + path.sep)) {
      const marker = readMarketMarker(current);
      if (marker) return marker;
      if (current === root) break;
      current = path.dirname(current);
    }
    return null;
  }

  function inferMarketSourceLabel(marker = {}) {
    const values = [
      marker.id,
      marker.sourceLabel,
      marker.upstreamSource,
      marker.upstreamId,
      marker.upstreamRepo,
      marker.upstreamPath
    ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
    if (!values.length) return "";
    if (values.some((value) => value.includes("claude-marketplace") || value.includes("anthropic"))) return "Claude";
    if (values.some((value) => value.includes("clawhub"))) return "ClawHub";
    if (values.some((value) => value.includes("skills-sh") || value.includes("skills.sh"))) return "skills.sh";
    if (values.some((value) => value.includes("browse-sh") || value.includes("browse.sh"))) return "browse.sh";
    if (values.some((value) => value.includes("lobehub"))) return "LobeHub";
    if (values.some((value) => value.includes("github"))) return "GitHub";
    if (values.some((value) => value.includes("official") || value.includes("hermes"))) return "Hermes";
    return "";
  }

  function applyMarketMarker(skill, marker) {
    skill.fromMarket = Boolean(marker);
    if (!marker) return skill;
    skill.marketId = marker.id || "";
    skill.marketVersion = marker.version || "";
    skill.marketChecksum = marker.checksum || "";
    skill.marketSourceLabel = marker.sourceLabel || inferMarketSourceLabel(marker);
    skill.marketUpstreamSource = marker.upstreamSource || "";
    skill.marketUpstreamId = marker.upstreamId || "";
    skill.marketUpstreamRepo = marker.upstreamRepo || "";
    skill.marketUpstreamPath = marker.upstreamPath || "";
    skill.marketTrustLevel = marker.trustLevel || "";
    skill.marketNameZh = marker.nameZh || marker.name_zh || "";
    skill.marketSummaryZh = marker.summaryZh || marker.summary_zh || "";
    skill.marketCategoryZh = marker.categoryZh || marker.category_zh || "";
    return skill;
  }

  function simpleYamlValue(text, key) {
    const match = String(text || "").match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return match ? cleanYamlScalar(match[1]) : "";
  }

  function simpleYamlList(text, key) {
    const lines = String(text || "").split(/\r?\n/);
    const out = [];
    let inList = false;
    for (const line of lines) {
      if (new RegExp(`^${key}:\\s*$`).test(line)) {
        inList = true;
        continue;
      }
      if (!inList) continue;
      if (/^\S/.test(line)) break;
      const item = line.match(/^\s*-\s+(.+)$/);
      if (item) out.push(cleanYamlScalar(item[1]));
    }
    return out;
  }

  function enumerateConnectors() {
    const connectors = [];
    const seen = new Set();
    return connectors
      .filter((connector) => {
        const key = connector.id || `${connector.kind}:${connector.path}:${connector.label}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => (
        String(a.kind || "").localeCompare(String(b.kind || ""))
        || String(a.sourceLabel || "").localeCompare(String(b.sourceLabel || ""))
        || String(a.label || "").localeCompare(String(b.label || ""))
      ));
  }

  function extensionCapabilitySummary(extension) {
    const parts = [];
    if (extension.skillCount) parts.push(`${extension.skillCount} Skills`);
    if (extension.commandCount) parts.push(`${extension.commandCount} Commands`);
    if (extension.agentCount) parts.push(`${extension.agentCount} Agents`);
    if (extension.toolCount) parts.push(`${extension.toolCount} Tools`);
    if (extension.hookCount) parts.push(`${extension.hookCount} Hooks`);
    if (extension.mcpCount) parts.push(`${extension.mcpCount} MCP`);
    return parts.join(" · ") || extension.status || "已发现";
  }

  function enumerateExtensions() {
    return []
      .map((extension) => ({ ...extension, capabilitySummary: extensionCapabilitySummary(extension) }))
      .sort((a, b) => (
        String(a.installState === "installed" ? "0" : "1").localeCompare(String(b.installState === "installed" ? "0" : "1"))
        ||
        String(a.engineLabel || "").localeCompare(String(b.engineLabel || ""))
        || String(a.label || a.name || "").localeCompare(String(b.label || b.name || ""))
      ));
  }

  // Writable private source: skills the user installed from the marketplace
  // land here (under the runtime home, not the read-only bundle). Scanned
  // like any source, and deletable because source === "mia".
  function miaPrivateSkillSource() {
    return {
      id: "mia:private",
      name: "mia",
      label: "我的技能",
      description: "从技能市场安装到本机的 Skill。",
      source: "mia",
      sourceLabel: "本机安装",
      kind: "private-skill-source",
      engine: "mia",
      root: path.join(runtimePaths().home, "skills"),
      idPrefix: "mia"
    };
  }

  function enumeratePlugins() {
    const out = [miaPrivateSkillSource()];
    for (const source of readMiaOfficialSkillSources()) {
      out.push(source);
    }
    return out;
  }

  // Install a marketplace skill by writing its SKILL.md body into the
  // private source. The cloud returns the full body (with frontmatter);
  // we drop it at <home>/skills/<id>/SKILL.md so the next scan surfaces it.
  // Extract a downloaded skill package (zip buffer) into the private source
  // <home>/skills/<id>. The dir is cleared first so re-install/update replaces
  // cleanly. Multi-file skills (scripts/references/assets) land intact.
  async function installMarketplaceSkill({ id, zipBuffer, marketVersion = "", marketMeta = null } = {}) {
    if (!id || !zipBuffer) {
      throw new Error("installMarketplaceSkill: id and zipBuffer required");
    }
    if (!isSafeId(id)) throw new Error("installMarketplaceSkill: invalid skill id");
    const skillDir = path.join(runtimePaths().home, "skills", String(id));
    const zip = new AdmZip(Buffer.from(zipBuffer));
    const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
    if (entries.length > MAX_FILES) throw new Error("package has too many files");
    let uncompressed = 0;
    for (const entry of entries) {
      if (!isSafeEntryName(entry.entryName)) throw new Error(`unsafe path in package: ${entry.entryName}`);
      uncompressed += Number(entry.header?.size || 0);
      if (uncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error("package uncompressed size too large");
    }
    // Clean + extract entry-by-entry, asserting each target stays inside skillDir (zip-slip guard).
    fs.rmSync(skillDir, { recursive: true, force: true });
    fs.mkdirSync(skillDir, { recursive: true });
    for (const entry of entries) {
      const target = assertInside(skillDir, path.join(skillDir, entry.entryName));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.getData());
    }
    // Provenance marker: this skill came from the market (not authored here),
    // so the UI hides "发布到市场" for it. Also records the installed version.
    fs.writeFileSync(
      path.join(skillDir, ".mia-market.json"),
      JSON.stringify({
        id: String(id),
        version: String(marketVersion || ""),
        ...(marketMeta && typeof marketMeta === "object" ? {
          sourceLabel: String(marketMeta.sourceLabel || ""),
          upstreamSource: String(marketMeta.upstreamSource || ""),
          upstreamId: String(marketMeta.upstreamId || ""),
          upstreamRepo: String(marketMeta.upstreamRepo || ""),
          upstreamPath: String(marketMeta.upstreamPath || ""),
          trustLevel: String(marketMeta.trustLevel || ""),
          checksum: String(marketMeta.checksum || ""),
          nameZh: String(marketMeta.nameZh || marketMeta.name_zh || ""),
          summaryZh: String(marketMeta.summaryZh || marketMeta.summary_zh || ""),
          categoryZh: String(marketMeta.categoryZh || marketMeta.category_zh || "")
        } : {})
      }),
      "utf8"
    );
    return loadLocalSkills();
  }

  // Zip a local skill's directory for publishing to the marketplace.
  function packageLocalSkill(skillId) {
    const found = resolveLocalSkill(skillId);
    if (!found) throw new Error("Skill not found.");
    const skillDir = path.dirname(found.filePath);
    const zip = new AdmZip();
    zip.addLocalFolder(skillDir);
    return {
      name: found.skill?.name || path.basename(skillDir),
      description: found.skill?.description || "",
      packageBase64: zip.toBuffer().toString("base64")
    };
  }

  function readMiaOfficialSkillSources() {
    const manifestPath = officialLibraryManifestPath();
    const manifest = readJson(manifestPath, null);
    if (!manifest || typeof manifest !== "object") return [];
    const libraryId = String(manifest.id || "mia-official").trim() || "mia-official";
    const libraryLabel = String(manifest.label || "Mia 官方库").trim() || "Mia 官方库";
    return (Array.isArray(manifest.skillSources) ? manifest.skillSources : [])
      .map((item) => {
        const id = String(item?.id || item?.name || "").trim();
        const root = resolveOfficialLibraryRoot(item?.root);
        if (!id || !root) return null;
        return {
          id: `${libraryId}:${id}`,
          name: String(item.name || id).trim(),
          label: String(item.label || item.name || id).trim(),
          description: String(item.description || manifest.description || "").trim(),
          source: libraryId,
          sourceLabel: libraryLabel,
          kind: "official-skill-source",
          engine: String(item.engine || "mia").trim(),
          root,
          idPrefix: String(item.idPrefix || libraryId).trim() || libraryId
        };
      })
      .filter(Boolean);
  }

  function readMiaOfficialBotPresets() {
    const manifestPath = officialLibraryManifestPath();
    const manifest = readJson(manifestPath, null);
    if (!manifest || typeof manifest !== "object") return [];
    return (Array.isArray(manifest.botPresets) ? manifest.botPresets : [])
      .map((item) => {
        const key = String(item?.key || item?.id || "").trim();
        const name = String(item?.name || "").trim();
        if (!key || !name) return null;
        return {
          key,
          cat: String(item.category || item.cat || "推荐").trim() || "推荐",
          emoji: String(item.emoji || "◇").trim() || "◇",
          c1: String(item.background || item.c1 || "#eef0ff").trim() || "#eef0ff",
          c2: String(item.color || item.c2 || "#5e5ce6").trim() || "#5e5ce6",
          name,
          tagline: String(item.tagline || "").trim(),
          line: String(item.line || item.description || "").trim(),
          desc: String(item.description || item.desc || item.line || "").trim(),
          demo: String(item.demo || "").trim(),
          persona: String(item.persona || item.personaText || "").trim(),
          agentEngine: String(item.agentEngine || item.agent_engine || "hermes").trim() || "hermes",
          capabilities: item.capabilities && typeof item.capabilities === "object" ? item.capabilities : {}
        };
      })
      .filter(Boolean);
  }

  async function fetchHermesSkillsCatalog(timeoutMs = 1500) {
    const state = getEngineState();
    if (!state?.running || !state?.baseUrl) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${state.baseUrl}/api/skills`, {
        headers: { Authorization: `Bearer ${apiKey()}` },
        signal: controller.signal
      });
      if (!response.ok) return null;
      const data = await response.json();
      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.skills)) return data.skills;
      if (Array.isArray(data?.items)) return data.items;
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadLocalSkills() {
    const pluginDefs = enumeratePlugins();
    const extensions = enumerateExtensions();
    const connectors = enumerateConnectors();
    const skills = [];
    const seenByName = new Set();
    const plugins = [];
    for (const plugin of pluginDefs) {
      if (!fs.existsSync(plugin.root)) {
        plugins.push({
          id: plugin.id,
          name: plugin.name,
          label: plugin.label,
          description: plugin.description,
          source: plugin.source,
          sourceLabel: plugin.sourceLabel || plugin.label,
          kind: plugin.kind || "skill-source",
          engine: plugin.engine || "",
          extensionId: plugin.extensionId || "",
          root: plugin.root,
          skillCount: 0
        });
        continue;
      }
      let pluginSkills = 0;
      for (const filePath of findSkillFiles(plugin.root)) {
        try {
          const skill = parseSkillMarkdown(filePath, plugin);
          if (plugin.source !== "mia" && seenByName.has(skill.name.toLowerCase())) continue;
          seenByName.add(skill.name.toLowerCase());
          skill.pluginId = plugin.id;
          skill.pluginLabel = plugin.label;
          skill.pluginSource = plugin.source;
          skill.extensionId = plugin.extensionId || "";
          skill.sourceKind = plugin.kind || "skill-source";
          applyMarketMarker(skill, readMarketMarkerForSkill(filePath, plugin.root));
          skills.push(skill);
          pluginSkills += 1;
        } catch (error) {
          appendEngineLog(`Skill scan skipped ${filePath}: ${error.message}`);
        }
      }
      plugins.push({
        id: plugin.id,
        name: plugin.name,
        label: plugin.label,
        description: plugin.description,
        source: plugin.source,
        sourceLabel: plugin.sourceLabel || plugin.label,
        kind: plugin.kind || "skill-source",
        engine: plugin.engine || "",
        extensionId: plugin.extensionId || "",
        root: plugin.root,
        skillCount: pluginSkills
      });
    }
    const hermes = await fetchHermesSkillsCatalog();
    if (hermes) {
      const enabledByName = new Map();
      for (const item of hermes) {
        const name = String(item?.name || "").trim();
        if (!name) continue;
        enabledByName.set(name, item?.enabled !== false);
      }
      for (const skill of skills) {
        if (enabledByName.has(skill.name)) skill.enabled = enabledByName.get(skill.name);
        else skill.enabled = true;
      }
    } else {
      for (const skill of skills) skill.enabled = true;
    }
    skills.sort((a, b) => (
      String(a.pluginLabel || "").localeCompare(String(b.pluginLabel || ""))
      || String(a.category || "").localeCompare(String(b.category || ""))
      || String(a.name).localeCompare(String(b.name))
    ));
    return {
      plugins,
      sources: plugins,
      extensions,
      connectors,
      skills,
      botPresets: readMiaOfficialBotPresets(),
      roots: plugins.map((p) => ({ source: p.source, label: p.label, root: p.root, exists: fs.existsSync(p.root) }))
    };
  }

  async function installMarketplacePlugin(extensionId) {
    void extensionId;
    throw new Error("Mia 插件安装源尚未接入；不会安装 Codex 或 Claude Code 来源的插件。");
  }

  function resolveLocalSkill(identifier) {
    const target = String(identifier || "").trim();
    if (!target) return null;
    for (const plugin of enumeratePlugins()) {
      if (!fs.existsSync(plugin.root)) continue;
      const inMiaPrivate = plugin.source === "mia" && isChildPath(runtimePaths().home, plugin.root);
      for (const filePath of findSkillFiles(plugin.root)) {
        try {
          const raw = fs.readFileSync(filePath, "utf8");
          const skill = parseSkillMarkdown(filePath, plugin);
          skill.pluginId = plugin.id;
          skill.pluginLabel = plugin.label;
          skill.pluginSource = plugin.source;
          applyMarketMarker(skill, readMarketMarkerForSkill(filePath, plugin.root));
          const aliases = [
            skill.id,
            skill.name,
            `${plugin.idPrefix || plugin.source}:${skill.relPath}`,
            path.basename(path.dirname(filePath))
          ].filter(Boolean);
          if (aliases.some((alias) => String(alias).trim() === target)) {
            return { filePath, root: plugin.root, inMiaPrivate, raw, skill };
          }
        } catch {
          // skip unreadable
        }
      }
    }
    return null;
  }

  function readLocalSkill(skillId) {
    const found = resolveLocalSkill(skillId);
    if (!found) throw new Error("Skill not found.");
    const stat = fs.statSync(found.filePath);
    if (stat.size > 2 * 1024 * 1024) throw new Error("Skill file is too large to preview.");
    return {
      ...found.skill,
      body: found.raw,
      filePath: found.filePath
    };
  }

  // Build a prompt block injecting the FULL content of the skills a Bot has
  // enabled (bot.capabilities.enabledSkills). Injected into every turn so the
  // agent actually has these skills regardless of engine-native skill loading —
  // this is what makes the per-Bot skill selection functional. Returns "" if
  // the Bot has no enabled skills.
  function buildEnabledSkillsContext(bot) {
    const caps = botCapabilitiesWithPresetDefaults(bot, readMiaOfficialBotPresets());
    const ids = Array.isArray(caps.enabledSkills) ? caps.enabledSkills : [];
    if (!ids.length) return "";
    const blocks = [];
    const seen = new Set();
    for (const id of ids) {
      const key = String(id || "").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const found = resolveLocalSkill(key);
      if (!found) continue;
      blocks.push(`=== Skill: ${found.skill?.name || key} ===\n${String(found.raw || "").trim()}\n=== End Skill ===`);
    }
    if (!blocks.length) return "";
    return [
      "当前 Bot 启用了以下 Skill。哪个与用户请求相关就严格按其指南执行，不相关则忽略：",
      "",
      blocks.join("\n\n")
    ].join("\n");
  }

  // Composer "使用" chips: the user explicitly picked these skills for THIS
  // turn. Their full content is already injected by buildEnabledSkillsContext
  // (the caller merges them into enabledSkills), so this only needs to be the
  // directive that tells the agent to actually USE them — distinct from the
  // "use whichever is relevant" framing of the enabled-skills block.
  function buildActiveSkillsDirective(activeSkillIds) {
    const ids = Array.isArray(activeSkillIds) ? activeSkillIds : [];
    const names = [];
    const seen = new Set();
    for (const id of ids) {
      const key = String(id || "").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const found = resolveLocalSkill(key);
      if (!found) continue; // unresolved → no content was injected, so don't name it
      names.push(found.skill?.name || key);
    }
    if (!names.length) return "";
    const list = names.map((name) => `「${name}」`).join("、");
    return `用户为这条消息明确选择了 Skill：${list}。请优先严格按这些 Skill 的指南完成本次任务（其完整内容已在上文 Skill 区块中给出）。`;
  }

  function expandLeadingSkillCommand(text, { mode = "inline" } = {}) {
    const trimmed = String(text || "");
    const match = trimmed.match(/^\s*\/([A-Za-z0-9_\/-]+)(?:[\s:]+([\s\S]+))?$/);
    if (!match) return null;
    const name = match[1];
    const userRequest = (match[2] || "").trim();
    const found = resolveLocalSkill(name);
    if (!found) return null;
    if (mode === "native") {
      return [
        `用户选择了 Mia Skill：${name}。`,
        "请优先使用运行环境里同名的 Skill；如果 Skill 工具需要命名空间，请选择最匹配这个名称的 Skill。",
        "",
        userRequest
          ? `用户请求：\n${userRequest}`
          : "用户还没有补充具体请求，请基于这个 Skill 询问必要细节或开始执行。"
      ].join("\n");
    }
    return [
      "请严格按以下 Skill 指南完成任务。",
      "",
      `=== Skill: ${name} ===`,
      found.raw.trim(),
      "=== End Skill ===",
      "",
      userRequest
        ? `用户请求：\n${userRequest}`
        : "（用户已选定此 skill，请按 skill 指南询问需要的细节或开始执行。）"
    ].join("\n");
  }

  async function deleteLocalSkill(skillId) {
    const found = resolveLocalSkill(skillId);
    if (!found) throw new Error("Skill not found.");
    if (!found.inMiaPrivate) throw new Error("只能删除 Mia 私有 Skill 目录里的 Skill。");
    const miaRoot = path.join(runtimePaths().home, "skills");
    const skillDir = path.dirname(found.filePath);
    if (!isChildPath(miaRoot, skillDir)) throw new Error("Skill path is outside the Mia skills directory.");
    fs.rmSync(skillDir, { recursive: true, force: true });
    return loadLocalSkills();
  }

  async function openLocalSkillDirectory(skillId) {
    const found = resolveLocalSkill(skillId);
    if (!found) throw new Error("Skill not found.");
    const skillDir = path.dirname(found.filePath);
    if (!fs.existsSync(skillDir)) throw new Error("Skill directory not found.");
    const error = await shell.openPath(skillDir);
    if (error) throw new Error(error);
    return { opened: true, path: skillDir };
  }

  return {
    // Public API consumed by IPC handlers
    loadLocalSkills,
    readLocalSkill,
    deleteLocalSkill,
    openLocalSkillDirectory,
    installMarketplaceSkill,
    packageLocalSkill,
    buildEnabledSkillsContext,
    buildActiveSkillsDirective,
    botCapabilitiesWithPresetDefaults: (bot) => botCapabilitiesWithPresetDefaults(bot, readMiaOfficialBotPresets()),
    readMiaOfficialBotPresets,
    installMarketplacePlugin,
    // Used by chat-engine adapters
    expandLeadingSkillCommand,
    // Internal helpers exposed for IPC + main.js fallback paths
    fetchHermesSkillsCatalog,
    resolveLocalSkill,
    parseSkillMarkdown,
    findSkillFiles,
    countDirectoryFiles,
    simpleYamlValue,
    simpleYamlList,
    enumerateConnectors,
    enumerateExtensions,
    enumeratePlugins,
    readMiaOfficialSkillSources,
    readMiaOfficialBotPresets,
    extensionCapabilitySummary,
  };
}

module.exports = {
  createSkillsLoader,
  cleanYamlScalar,
};
