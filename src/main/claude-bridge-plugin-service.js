const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function createClaudeBridgePluginService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  const fsImpl = deps.fs || fs;
  const createHash = deps.createHash || ((algorithm) => crypto.createHash(algorithm));

  function ensureInstalled() {
    const p = runtimePaths();
    const bridgeDir = path.join(p.runtime, "claude-bridge-plugin");
    const manifestDir = path.join(bridgeDir, ".claude-plugin");
    const manifestPath = path.join(manifestDir, "plugin.json");
    const bridgeSkillsDir = path.join(bridgeDir, "skills");

    fsImpl.mkdirSync(manifestDir, { recursive: true });
    if (!fsImpl.existsSync(manifestPath)) {
      fsImpl.writeFileSync(manifestPath, JSON.stringify({
        name: "aimashi-skills",
        version: "1.0.0",
        description: "Aimashi bridge: surfaces Hermes runtime skills to Claude Code engine."
      }, null, 2) + "\n");
    }

    fsImpl.rmSync(bridgeSkillsDir, { recursive: true, force: true });
    fsImpl.mkdirSync(bridgeSkillsDir, { recursive: true });

    const sourceRoots = [
      { key: "aimashi", root: path.join(p.home, "skills") }
    ];
    const seen = new Set();
    for (const source of sourceRoots) {
      const root = source.root;
      if (!fsImpl.existsSync(root)) continue;
      let categories = [];
      try { categories = fsImpl.readdirSync(root); } catch { continue; }
      for (const category of categories) {
        const categoryPath = path.join(root, category);
        let stat;
        try { stat = fsImpl.statSync(categoryPath); } catch { continue; }
        if (!stat.isDirectory()) continue;
        let skills = [];
        try { skills = fsImpl.readdirSync(categoryPath); } catch { continue; }
        for (const skill of skills) {
          const skillPath = path.join(categoryPath, skill);
          let skillStat;
          try { skillStat = fsImpl.statSync(skillPath); } catch { continue; }
          if (!skillStat.isDirectory()) continue;
          if (!fsImpl.existsSync(path.join(skillPath, "SKILL.md"))) continue;
          const candidates = [
            skill,
            `${source.key}-${skill}`,
            skill.startsWith(`${category}-`) ? `${source.key}-${category}-${skill}` : `${category}-${skill}`
          ];
          const linkName = candidates.find((candidate) => !seen.has(candidate));
          if (!linkName) continue;
          seen.add(linkName);
          try {
            fsImpl.symlinkSync(skillPath, path.join(bridgeSkillsDir, linkName), "dir");
          } catch {
            // Ignore individual symlink failures; the remaining valid skills can still be exposed.
          }
        }
      }
    }
    const fingerprint = createHash("sha256")
      .update([...seen].sort().join("\n"))
      .digest("hex")
      .slice(0, 16);
    return { path: bridgeDir, fingerprint };
  }

  return { ensureInstalled };
}

module.exports = { createClaudeBridgePluginService };
