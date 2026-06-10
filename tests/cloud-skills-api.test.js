const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const AdmZip = require("adm-zip");
const { freePort } = require("./helpers/free-port");

function skillZipBase64(bodyText) {
  const zip = new AdmZip();
  zip.addFile("SKILL.md", Buffer.from(bodyText || "---\nname: x\n---\n# X"));
  return zip.toBuffer().toString("base64");
}

async function startServer(extraEnv = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-test-"));
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["scripts/serve-cloud.js"], {
      env: {
        ...process.env,
        MIA_CLOUD_HOST: "127.0.0.1",
        MIA_CLOUD_PORT: String(port),
        MIA_CLOUD_DATA: tmpDir,
        MIA_HERMES_SKILLS_MARKET: "0",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve({ proc, port, tmpDir }); } };
    proc.stdout.on("data", (chunk) => { if (/listening|Listening/.test(chunk.toString())) done(); });
    proc.stderr.on("data", (chunk) => { if (/listening|Listening|mia-cloud/i.test(chunk.toString())) done(); });
    proc.on("error", reject);
    setTimeout(done, 1500);
  });
}

async function startHermesFixtureServer({ skillCount = 1 } = {}) {
  const port = await freePort();
  const archive = new AdmZip();
  archive.addFile("repo-main/skills/demo-remote/SKILL.md", Buffer.from("---\nname: demo-remote\n---\n# Demo Remote\n"));
  archive.addFile("repo-main/skills/demo-remote/references/notes.md", Buffer.from("# Notes\n"));
  const skills = Array.from({ length: skillCount }, (_item, index) => {
    if (index === 0) {
      return {
        name: "demo-remote",
        description: "Remote GitHub skill",
        source: "github",
        identifier: "owner/repo/skills/demo-remote",
        trust_level: "community",
        repo: "owner/repo",
        path: "skills/demo-remote",
        tags: ["software"],
        extra: {}
      };
    }
    const n = String(index).padStart(3, "0");
    return {
      name: `remote-skill-${n}`,
      description: `Remote test skill ${n}`,
      source: "github",
      identifier: `owner/repo/skills/remote-skill-${n}`,
      trust_level: "community",
      repo: "owner/repo",
      path: `skills/remote-skill-${n}`,
      tags: ["software"],
      extra: {}
    };
  });
  const server = http.createServer((req, res) => {
    if (req.url === "/index.json") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        version: 1,
        generated_at: "2026-05-28T03:27:06.731039+00:00",
        skill_count: skills.length,
        skills
      }));
    }
    if (req.url === "/github-archive/owner/repo/zip/HEAD") {
      const buf = archive.toBuffer();
      res.writeHead(200, { "content-type": "application/zip", "content-length": buf.length });
      return res.end(buf);
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function stopServer(ctx) {
  if (ctx.proc.exitCode === null && ctx.proc.signalCode === null) {
    ctx.proc.kill("SIGTERM");
    await new Promise((r) => ctx.proc.once("exit", r));
  }
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
}

function api(port, method, pathStr, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: "127.0.0.1", port, path: pathStr, method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
    }, (res) => {
      let chunks = "";
      res.on("data", (c) => { chunks += c; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function register(port, username) {
  const r = await api(port, "POST", "/api/auth/register", { body: { username, password: "Pa55word!" } });
  if (r.status !== 201) throw new Error("register failed: " + JSON.stringify(r));
  const login = await api(port, "POST", "/api/auth/login", { body: { username, password: "Pa55word!" } });
  return { user: login.body.user, token: login.body.token };
}

test("GET /api/skills lists seeded catalog with categories, no body", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const r = await api(ctx.port, "GET", "/api/skills", { token: alice.token });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.skills) && r.body.skills.length >= 3);
    assert.ok(Array.isArray(r.body.categories) && r.body.categories.length >= 1);
    const one = r.body.skills.find((s) => s.id === "pdf");
    assert.ok(one, "seeded pdf present");
    assert.equal(one.installCount, 0, "install count starts honest at 0");
    assert.equal(one.body, undefined, "list payload omits body");
  } finally { await stopServer(ctx); }
});

test("GET /api/skills requires auth", async () => {
  const ctx = await startServer();
  try {
    const r = await api(ctx.port, "GET", "/api/skills");
    assert.equal(r.status, 401);
  } finally { await stopServer(ctx); }
});

test("GET /api/skills?category= filters", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const r = await api(ctx.port, "GET", "/api/skills?category=" + encodeURIComponent("research"), { token: alice.token });
    assert.equal(r.status, 200);
    assert.ok(r.body.skills.length >= 1);
    assert.ok(r.body.skills.every((s) => s.category === "research"));
  } finally { await stopServer(ctx); }
});

test("GET /api/skills/:id returns listing + latest version meta (no raw body)", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const r = await api(ctx.port, "GET", "/api/skills/pdf", { token: alice.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.skill.id, "pdf");
    assert.equal(r.body.skill.latestVersion, "1.0.0");
    assert.ok(r.body.skill.version && r.body.skill.version.checksum, "carries a packaged version");
    assert.equal(r.body.skill.body, undefined, "detail no longer ships a raw body");
  } finally { await stopServer(ctx); }
});

test("POST install bumps count once per user, returns download info; package downloads", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");

    const i1 = await api(ctx.port, "POST", "/api/skills/pdf/install", { token: alice.token });
    assert.equal(i1.status, 200);
    assert.equal(i1.body.skill.installCount, 1);
    assert.ok(i1.body.download && i1.body.download.url && i1.body.download.checksum, "install returns package download info");

    // the package itself downloads (zip bytes, 200)
    const pkg = await api(ctx.port, "GET", i1.body.download.url, { token: alice.token });
    assert.equal(pkg.status, 200);

    // same user re-installs → idempotent, no inflation
    const i2 = await api(ctx.port, "POST", "/api/skills/pdf/install", { token: alice.token });
    assert.equal(i2.body.skill.installCount, 1);

    // a different user → count grows
    const i3 = await api(ctx.port, "POST", "/api/skills/pdf/install", { token: bob.token });
    assert.equal(i3.body.skill.installCount, 2);
  } finally { await stopServer(ctx); }
});

test("Hermes remote skills appear in market and install as real packages", async () => {
  const fixture = await startHermesFixtureServer();
  const ctx = await startServer({
    MIA_HERMES_SKILLS_MARKET: "1",
    MIA_HERMES_SKILLS_INDEX_URL: `${fixture.url}/index.json`,
    MIA_HERMES_GITHUB_ARCHIVE_BASE_URL: `${fixture.url}/github-archive`
  });
  try {
    const alice = await register(ctx.port, "alice");
    const list = await api(ctx.port, "GET", "/api/skills", { token: alice.token });
    assert.equal(list.status, 200);
    const remote = list.body.skills.find((skill) => skill.name === "demo-remote");
    assert.ok(remote, "remote Hermes skill is listed");
    assert.equal(remote.sourceLabel, "GitHub");
    assert.equal(remote.upstreamId, "owner/repo/skills/demo-remote");

    const inst = await api(ctx.port, "POST", `/api/skills/${encodeURIComponent(remote.id)}/install`, { token: alice.token });
    assert.equal(inst.status, 200);
    assert.equal(inst.body.skill.id, remote.id);
    assert.ok(inst.body.download.url.includes("/api/hermes-skills/"));
    assert.match(inst.body.download.checksum, /^[a-f0-9]{64}$/);

    const pkg = await api(ctx.port, "GET", inst.body.download.url, { token: alice.token });
    assert.equal(pkg.status, 200);
  } finally {
    await stopServer(ctx);
    await fixture.close();
  }
});

test("GET /api/skills defaults to a bounded page but honors explicit limits", async () => {
  const fixture = await startHermesFixtureServer({ skillCount: 240 });
  const ctx = await startServer({
    MIA_HERMES_SKILLS_MARKET: "1",
    MIA_HERMES_SKILLS_INDEX_URL: `${fixture.url}/index.json`,
    MIA_HERMES_GITHUB_ARCHIVE_BASE_URL: `${fixture.url}/github-archive`
  });
  try {
    const alice = await register(ctx.port, "alice");
    const defaultPage = await api(ctx.port, "GET", "/api/skills", { token: alice.token });
    assert.equal(defaultPage.status, 200);
    assert.equal(defaultPage.body.skills.length, 120);

    const largerPage = await api(ctx.port, "GET", "/api/skills?limit=200", { token: alice.token });
    assert.equal(largerPage.status, 200);
    assert.equal(largerPage.body.skills.length, 200);
  } finally {
    await stopServer(ctx);
    await fixture.close();
  }
});

test("POST /api/skills publishes a user skill; it appears in the market and is installable", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const pub = await api(ctx.port, "POST", "/api/skills", {
      token: alice.token,
      body: { name: "My Helper", category: "办公学习", description: "mine", packageBase64: skillZipBase64("---\nname: My Helper\n---\n# Mine") }
    });
    assert.equal(pub.status, 201);
    assert.equal(pub.body.skill.id, "alice.my-helper");
    assert.equal(pub.body.skill.ownerLabel, "alice");
    assert.equal(pub.body.skill.latestVersion, "1.0.0");

    const list = await api(ctx.port, "GET", "/api/skills", { token: alice.token });
    assert.ok(list.body.skills.some((s) => s.id === "alice.my-helper"));

    const inst = await api(ctx.port, "POST", "/api/skills/alice.my-helper/install", { token: alice.token });
    assert.equal(inst.status, 200);
    assert.ok(inst.body.download.url);
    const pkg = await api(ctx.port, "GET", inst.body.download.url, { token: alice.token });
    assert.equal(pkg.status, 200);
  } finally { await stopServer(ctx); }
});

test("POST /api/skills cannot take over an official skill (id is namespaced to the user)", async () => {
  const ctx = await startServer();
  try {
    const bob = await register(ctx.port, "bob");
    // bob publishes a skill literally named "pdf" (an official seed id)
    const pub = await api(ctx.port, "POST", "/api/skills", {
      token: bob.token,
      body: { id: "pdf", name: "pdf", packageBase64: skillZipBase64("---\nname: pwn\n---\n# pwn") }
    });
    assert.equal(pub.status, 201);
    assert.equal(pub.body.skill.id, "bob.pdf", "client id ignored; namespaced to user");
    // the official pdf is untouched (still Mia 官方, not bob's)
    const official = await api(ctx.port, "GET", "/api/skills/pdf", { token: bob.token });
    assert.equal(official.status, 200);
    assert.notEqual(official.body.skill.ownerLabel, "bob");
  } finally { await stopServer(ctx); }
});

test("POST /api/skills namespaces per user — bob cannot write into alice's namespace", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const a = await api(ctx.port, "POST", "/api/skills", {
      token: alice.token,
      body: { name: "Shared", packageBase64: skillZipBase64() }
    });
    assert.equal(a.body.skill.id, "alice.shared");
    // bob tries to target alice's namespaced id → rejected
    const b = await api(ctx.port, "POST", "/api/skills", {
      token: bob.token,
      body: { id: "alice.shared", name: "Shared", packageBase64: skillZipBase64() }
    });
    assert.equal(b.status, 403, "cross-namespace publish rejected");
    // alice's skill is untouched
    const aliceSkill = await api(ctx.port, "GET", "/api/skills/alice.shared", { token: alice.token });
    assert.equal(aliceSkill.body.skill.ownerLabel, "alice");
  } finally { await stopServer(ctx); }
});

test("POST /api/skills/:id/install → 404 for unknown skill", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const r = await api(ctx.port, "POST", "/api/skills/nope_not_real/install", { token: alice.token });
    assert.equal(r.status, 404);
  } finally { await stopServer(ctx); }
});
