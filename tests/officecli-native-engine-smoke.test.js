const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const OFFICECLI_SKILL = path.join(ROOT, "skills", "_builtin", "officecli", "SKILL.md");
const NATURAL_PROMPT = "帮我做一份季度汇报文档";
const RUN_NATIVE_SMOKE = process.env.MIA_OFFICECLI_NATIVE_ENGINE_SMOKE === "1";

function requireCli(name, versionArgs = ["--version"]) {
  const result = childProcess.spawnSync(name, versionArgs, { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, `${name} is unavailable or broken: ${result.stderr || result.stdout}`);
  return String(result.stdout || result.stderr || "").trim();
}

function installProjectSkill(workspace, relativeRoot) {
  const target = path.join(workspace, relativeRoot, "officecli");
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(OFFICECLI_SKILL, path.join(target, "SKILL.md"));
  return target;
}

test("real Claude Code, Codex, and Hermes CLIs discover OfficeCLI through their native skill paths", {
  timeout: 30000,
  skip: RUN_NATIVE_SMOKE ? false : "set MIA_OFFICECLI_NATIVE_ENGINE_SMOKE=1 to run the host CLI smoke"
}, () => {
  assert.match(requireCli("claude"), /Claude Code/i);
  assert.match(requireCli("codex"), /codex-cli/i);
  assert.match(requireCli("hermes"), /Hermes Agent v0\.16\./i);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mia-officecli-native-engines-"));
  try {
    const home = path.join(tmp, "home");
    const workspace = path.join(tmp, "workspace");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    childProcess.execFileSync("git", ["init", "-q", workspace]);

    const claudeSkill = installProjectSkill(workspace, path.join(".claude", "skills"));
    const claude = childProcess.spawnSync("claude", [
      "--setting-sources", "project",
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      NATURAL_PROMPT
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
        ANTHROPIC_API_KEY: "mia-native-skill-smoke"
      },
      encoding: "utf8",
      timeout: 7000,
      maxBuffer: 4 * 1024 * 1024
    });
    const claudeEvents = String(claude.stdout || "").split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const claudeInit = claudeEvents.find((event) => event.type === "system" && event.subtype === "init");
    assert.ok(claudeInit, claude.stderr || claude.stdout || "Claude Code did not emit an init event");
    assert.equal(claudeInit.skills.includes("officecli"), true);
    assert.equal(fs.existsSync(path.join(claudeSkill, "SKILL.md")), true);

    const codexSkill = installProjectSkill(workspace, path.join(".codex", "skills"));
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    const codex = childProcess.spawnSync("codex", ["debug", "prompt-input", NATURAL_PROMPT], {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: path.join(home, ".codex")
      },
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024
    });
    assert.equal(codex.status, 0, codex.stderr || codex.stdout);
    const codexInput = JSON.parse(codex.stdout);
    const codexTexts = codexInput.flatMap((item) => item.content || []).map((content) => content.text || "");
    assert.equal(codexTexts.some((text) => text.includes("- officecli:") && text.includes(`${codexSkill}/SKILL.md`)), true);
    assert.equal(codexTexts.at(-1), NATURAL_PROMPT);

    const hermesHome = path.join(home, ".hermes");
    const hermesSkill = installProjectSkill(workspace, path.join(".mia", "hermes-skills"));
    fs.mkdirSync(hermesHome, { recursive: true });
    fs.writeFileSync(
      path.join(hermesHome, "config.yaml"),
      "skills:\n  external_dirs:\n    - \"${MIA_HERMES_SKILLS_DIR}\"\n"
    );
    const hermesLauncher = childProcess.execFileSync("which", ["hermes"], { encoding: "utf8" }).trim();
    const hermesPython = fs.readFileSync(hermesLauncher, "utf8").split("\n", 1)[0].replace(/^#!/, "").trim();
    const pythonUserSite = childProcess.execFileSync(
      hermesPython,
      ["-c", "import site; print(site.getusersitepackages())"],
      { encoding: "utf8" }
    ).trim();
    const hermes = childProcess.spawnSync("hermes", ["skills", "list", "--enabled-only"], {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: home,
        HERMES_HOME: hermesHome,
        MIA_HERMES_SKILLS_DIR: path.dirname(hermesSkill),
        PYTHONPATH: [pythonUserSite, process.env.PYTHONPATH || ""].filter(Boolean).join(path.delimiter)
      },
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024
    });
    assert.equal(hermes.status, 0, hermes.stderr || hermes.stdout);
    assert.match(hermes.stdout, /officecli/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
