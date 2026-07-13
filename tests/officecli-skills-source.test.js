const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_MANIFEST = path.join(ROOT, "skills", "_builtin", "officecli-sources.json");

const EXPECTED_SKILLS = Object.freeze({
  "mia-official:officecli": Object.freeze({
    path: "skills/_builtin/officecli/SKILL.md",
    revision: "v1.0.135",
    commit: "d2d9c60f44537004c3e1f46680c24ea38d9659c2",
    sha256: "b1886ce52f83b8d0f612f32edf5546a5fe5403900b0e67d3a26ca22e76c1915d"
  }),
  "mia-official:officecli-docx": Object.freeze({
    path: "skills/_builtin/officecli-docx/SKILL.md",
    revision: "abbcd7823d4165781c2d9f6bacadc6bdbe17aef2",
    commit: "abbcd7823d4165781c2d9f6bacadc6bdbe17aef2",
    sha256: "181f67f99874e70a18ce0a4cd589ebd6a8511ae607f7c6b05e1c8635b10cfbbd"
  }),
  "mia-official:officecli-xlsx": Object.freeze({
    path: "skills/_builtin/officecli-xlsx/SKILL.md",
    revision: "abbcd7823d4165781c2d9f6bacadc6bdbe17aef2",
    commit: "abbcd7823d4165781c2d9f6bacadc6bdbe17aef2",
    sha256: "e80ed015aaf24a025219134c451eb77c873e125dec057e8a48d3f9e89f92cfa3"
  }),
  "mia-official:officecli-pptx": Object.freeze({
    path: "skills/_builtin/officecli-pptx/SKILL.md",
    revision: "abbcd7823d4165781c2d9f6bacadc6bdbe17aef2",
    commit: "abbcd7823d4165781c2d9f6bacadc6bdbe17aef2",
    sha256: "e23986762b5647f2b0e53321ee0768e04ff347cf65b6f517b25527049bbbf07f"
  })
});

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

test("OfficeCLI vendored skills keep the approved immutable upstream bytes", () => {
  assert.equal(fs.existsSync(SOURCE_MANIFEST), true, "OfficeCLI source manifest must exist");
  const manifest = JSON.parse(fs.readFileSync(SOURCE_MANIFEST, "utf8"));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.license, "Apache-2.0");

  for (const [id, expected] of Object.entries(EXPECTED_SKILLS)) {
    const source = manifest.skills[id];
    assert.ok(source, `${id} must have source provenance`);
    assert.equal(source.path, expected.path);
    assert.equal(source.revision, expected.revision);
    assert.equal(source.commit, expected.commit);
    assert.equal(source.sha256, expected.sha256);
    assert.match(source.url, /^https:\/\/raw\.githubusercontent\.com\/iOfficeAI\//);

    const skillPath = path.join(ROOT, expected.path);
    assert.equal(fs.existsSync(skillPath), true, `${expected.path} must exist`);
    assert.equal(sha256File(skillPath), expected.sha256, `${id} body must remain byte-identical`);
  }
});

test("OfficeCLI vendoring carries Apache license and attribution", () => {
  const licensePath = path.join(ROOT, "skills", "_builtin", "officecli", "LICENSE");
  const upstreamNoticePath = path.join(ROOT, "skills", "_builtin", "officecli", "UPSTREAM_NOTICE");
  const noticePath = path.join(ROOT, "skills", "_builtin", "officecli", "THIRD_PARTY_NOTICES.md");
  assert.match(fs.readFileSync(licensePath, "utf8"), /Apache License[\s\S]*Version 2\.0, January 2004/);
  assert.equal(
    sha256File(upstreamNoticePath),
    "3a4715b268e148a8e9566f5e835f766f5c95c3da4d6e5ddd908806a258a2f07b"
  );
  const notice = fs.readFileSync(noticePath, "utf8");
  assert.match(notice, /iOfficeAI\/OfficeCLI/);
  assert.match(notice, /iOfficeAI\/AionCore/);
  assert.match(notice, /unmodified|未修改/i);
});

test("OfficeCLI local source check is offline and succeeds without rewriting vendored files", () => {
  const before = Object.fromEntries(Object.values(EXPECTED_SKILLS).map(({ path: relativePath }) => [
    relativePath,
    fs.statSync(path.join(ROOT, relativePath)).mtimeMs
  ]));
  const result = spawnSync(process.execPath, ["scripts/sync-officecli-skills.js", "--check"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, HTTPS_PROXY: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1" }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /OfficeCLI vendored skills verified/);
  for (const [relativePath, mtimeMs] of Object.entries(before)) {
    assert.equal(fs.statSync(path.join(ROOT, relativePath)).mtimeMs, mtimeMs);
  }
});

test("desktop checks and Cloud release requirements include OfficeCLI provenance", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["officecli:skills:check"], "node scripts/sync-officecli-skills.js --check");
  assert.equal(packageJson.scripts["officecli:skills:sync"], "node scripts/sync-officecli-skills.js --update");

  const sourceCheck = fs.readFileSync(path.join(ROOT, "src", "check.js"), "utf8");
  const releaseBuilder = fs.readFileSync(path.join(ROOT, "scripts", "build-cloud-release.js"), "utf8");
  for (const relativePath of [
    "skills/_builtin/officecli/SKILL.md",
    "skills/_builtin/officecli/LICENSE",
    "skills/_builtin/officecli/UPSTREAM_NOTICE",
    "skills/_builtin/officecli/THIRD_PARTY_NOTICES.md",
    "skills/_builtin/officecli-docx/SKILL.md",
    "skills/_builtin/officecli-xlsx/SKILL.md",
    "skills/_builtin/officecli-pptx/SKILL.md",
    "skills/_builtin/officecli-sources.json"
  ]) {
    assert.match(sourceCheck, new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(releaseBuilder, new RegExp(`api/${relativePath}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
