const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCoreBotExecution } = require("../src/core/mia-core.js");
const { createRuntimePaths } = require("../src/main/runtime-paths.js");
const { MIA_MEMORY_HEADER } = require("../src/main/mia-memory-service.js");

// Functional-parity proof: a Hermes turn run via Core injects the SAME memory
// block + enabled-skills context + active-skills directive the Electron daemon
// does. We do NOT fake `sendHermesChat` (that would bypass the real Hermes
// adapter where memoryBlock + buildEnabledSkillsContext live). Instead we fake
// the lowest layer — `fetchImpl` — so the REAL hermesAdapter.sendChat runs and
// we capture the exact `/v1/runs` POST body it builds. The captured body's
// `instructions` (system prompt) carries the memory block, and its `input` (last
// user message) carries the injected skill content + active-skills directive.

// A node-only SSE-stream Response stub: returns one `run.completed` frame so the
// real readRunEventStream resolves deterministically (no network, no timers).
function sseStreamResponse(frames) {
  const text = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data || {})}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    body: {
      getReader() {
        return {
          read() {
            if (sent) return Promise.resolve({ value: undefined, done: true });
            sent = true;
            return Promise.resolve({ value: bytes, done: false });
          },
          cancel() { return Promise.resolve(); }
        };
      }
    }
  };
}

function jsonResponse(obj) {
  const text = JSON.stringify(obj);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(obj)
  };
}

function makeTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-fidelity-"));
  return home;
}

test("a Hermes turn via Core injects the REAL memory block + enabled-skills + active directive (node-only)", async () => {
  const home = makeTempHome();
  try {
    // Real runtime paths rooted at the temp MIA_HOME (single-owner data home).
    const { runtimePaths } = createRuntimePaths({
      app: { getPath: () => os.homedir() },
      MIA_GATEWAY_SERVICE_LABEL: "ai.mia.hermes.gateway",
      MIA_DAEMON_SERVICE_LABEL: "ai.mia.daemon",
      env: { MIA_HOME: home }
    });

    // (a) Seed memory in the on-disk format mia-memory-service writes/reads.
    fs.mkdirSync(path.dirname(runtimePaths().memory), { recursive: true });
    fs.writeFileSync(
      runtimePaths().memory,
      JSON.stringify({
        shared: ["用户偏好简洁的中文回复"],
        bots: { bot1: ["这个 Bot 负责论文写作"] },
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );

    // (b) Seed a private skill the loader will discover at <home>/skills/<id>/SKILL.md.
    const skillDir = path.join(home, "skills", "demo-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: A demo skill.\n---\n# Demo Skill\nUNIQUE_SKILL_BODY_MARKER step one.\n",
      "utf8"
    );

    // Capture the run payload the REAL Hermes adapter posts. Only the HTTP layer
    // (fetch) is faked; memoryBlock + buildEnabledSkillsContext + buildActiveSkillsDirective
    // all run for real on the path to this fetch.
    let capturedRunBody = null;
    const fetchImpl = (url, init = {}) => {
      const u = String(url);
      if (u.endsWith("/v1/runs")) {
        capturedRunBody = JSON.parse(init.body);
        return Promise.resolve(jsonResponse({ run_id: "run_fidelity" }));
      }
      if (/\/v1\/runs\/.+\/events$/.test(u)) {
        return Promise.resolve(sseStreamResponse([
          { event: "run.completed", data: { text: "done" } }
        ]));
      }
      return Promise.resolve(jsonResponse({}));
    };

    const core = createCoreBotExecution({
      runtimePaths,
      settingsStore: { daemonSettings: () => ({ enabled: false }) },
      hermesBaseUrl: "http://hermes.local",
      apiKey: "test-key",
      // NOTE: no sendHermesChat override → the real hermesAdapter.sendChat runs.
      fetchImpl
    });

    const response = await core.sendChat({
      botKey: "bot1",
      botSnapshot: {
        key: "bot1",
        name: "Bot One",
        agentEngine: "hermes",
        capabilities: { enabledSkills: ["demo-skill"] }
      },
      sessionId: "s1",
      messages: [{ role: "user", content: "帮我整理一下" }],
      // Foreground turn (not background) so buildActiveSkillsDirective runs over
      // the composer-selected chips.
      activeSkillIds: ["demo-skill"]
    });

    // The real adapter graph flowed the canned stream back through.
    assert.equal(response.choices[0].message.content, "done");
    assert.ok(capturedRunBody, "expected the real Hermes adapter to POST a run body");

    // (a) Memory block is applied: the system instructions carry the Mia memory
    // header and the seeded shared + bot memory — proving memoryBlock is the real
    // service, not the () => "" stub.
    assert.ok(
      capturedRunBody.instructions && capturedRunBody.instructions.includes(MIA_MEMORY_HEADER),
      "memory block missing from run instructions"
    );
    assert.ok(
      capturedRunBody.instructions.includes("用户偏好简洁的中文回复"),
      "seeded shared memory missing"
    );
    assert.ok(
      capturedRunBody.instructions.includes("这个 Bot 负责论文写作"),
      "seeded bot memory missing"
    );

    // (b) Enabled-skills context is applied: the seeded skill's body is injected
    // into the user input — proving buildEnabledSkillsContext is the real loader,
    // not the () => "" stub.
    assert.ok(
      capturedRunBody.input.includes("UNIQUE_SKILL_BODY_MARKER"),
      "enabled-skill content missing from run input"
    );
    assert.ok(
      capturedRunBody.input.includes("=== Skill: demo-skill ==="),
      "enabled-skill block framing missing"
    );

    // (c) Active-skills directive is applied (bot-execution-core path): the
    // composer-selected skill is named — proving skillsLoader.buildActiveSkillsDirective
    // is the real loader, not the () => "" stub.
    assert.ok(
      capturedRunBody.input.includes("「demo-skill」"),
      "active-skills directive missing the selected skill name"
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
