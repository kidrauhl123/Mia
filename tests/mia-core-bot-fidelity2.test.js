const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCoreBotExecution } = require("../src/core/mia-core.js");
const { createRuntimePaths } = require("../src/main/runtime-paths.js");

// Functional-parity proof #2 for the formerly-stubbed Hermes adapter deps:
//   (A) attachments — a Hermes turn carrying a local attachment injects the REAL
//       "附件上下文" block + text preview into the /v1/runs payload `input`,
//       proving createChatAttachments.attachmentContext is wired (not () => "").
//   (B) MCP context — the same turn writes the REAL scheduler + Mia-app
//       context.json files under Core's runtime home with this turn's
//       {botId, sessionId, originMessageId}, proving the two MCP bridges'
//       writeContext are wired (not () => {}).
//
// As in fidelity #1 we do NOT fake sendHermesChat — only the lowest layer
// (fetchImpl) — so the REAL hermesAdapter.sendChat runs and we capture the exact
// /v1/runs POST body. Deterministic, temp dirs, no network/timers, torn down.

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

test("a Hermes turn via Core injects REAL attachment context + writes REAL MCP context.json (node-only)", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-fidelity2-"));
  // MIA_HOME's parent dir is runtimePaths().runtime (where the MCP bridges write
  // context.json). Nesting home under <base>/runtime/engine-home keeps runtime
  // (= <base>/runtime) inside our temp tree, never the shared /tmp.
  const home = path.join(base, "runtime", "engine-home");
  try {
    const { runtimePaths } = createRuntimePaths({
      app: { getPath: () => os.homedir() },
      MIA_GATEWAY_SERVICE_LABEL: "ai.mia.hermes.gateway",
      MIA_DAEMON_SERVICE_LABEL: "ai.mia.daemon",
      env: { MIA_HOME: home }
    });

    // A real local attachment file with a unique marker so the REAL
    // attachmentContext text-preview path (fs.readFileSync) is what surfaces it.
    const attachmentPath = path.join(base, "notes.txt");
    fs.writeFileSync(attachmentPath, "UNIQUE_ATTACHMENT_PREVIEW_MARKER line one.\n", "utf8");

    let capturedRunBody = null;
    const fetchImpl = (url, init = {}) => {
      const u = String(url);
      if (u.endsWith("/v1/runs")) {
        capturedRunBody = JSON.parse(init.body);
        return Promise.resolve(jsonResponse({ run_id: "run_fidelity2" }));
      }
      if (/\/v1\/runs\/.+\/events$/.test(u)) {
        return Promise.resolve(sseStreamResponse([{ event: "run.completed", data: { text: "done" } }]));
      }
      return Promise.resolve(jsonResponse({}));
    };

    const core = createCoreBotExecution({
      runtimePaths,
      settingsStore: {
        daemonSettings: () => ({ enabled: false }),
        cloudSettings: () => ({ enabled: false }),
        normalizeCloudUrl: (value) => String(value || "")
      },
      hermesBaseUrl: "http://hermes.local",
      apiKey: "test-key",
      fetchImpl
    });

    const response = await core.sendChat({
      botKey: "botX",
      botSnapshot: { key: "botX", name: "Bot X", agentEngine: "hermes" },
      sessionId: "sess-77",
      messages: [{
        id: "umsg-123",
        role: "user",
        content: "看一下这个文件",
        attachments: [{
          name: "notes.txt",
          path: attachmentPath,
          mime: "text/plain",
          kind: "text"
        }]
      }]
    });

    assert.equal(response.choices[0].message.content, "done");
    assert.ok(capturedRunBody, "expected the real Hermes adapter to POST a run body");

    // (A) Attachment context is applied: the framing header + the file metadata +
    // the unique text preview all appear in `input` — proving attachmentContext is
    // the real chat-attachments method, not the () => "" stub.
    assert.ok(
      capturedRunBody.input.includes("附件上下文："),
      "attachment-context framing missing from run input"
    );
    assert.ok(
      capturedRunBody.input.includes("notes.txt"),
      "attachment filename missing from run input"
    );
    assert.ok(
      capturedRunBody.input.includes("UNIQUE_ATTACHMENT_PREVIEW_MARKER"),
      "attachment text preview missing — attachmentContext stub still wired"
    );

    // (B) MCP context.json files are written for this turn under Core's runtime
    // home — proving writeSchedulerMcpContext + writeMiaAppMcpContext are the real
    // bridges, not the () => {} stubs.
    const runtimeDir = runtimePaths().runtime;
    const schedulerContextPath = path.join(runtimeDir, "scheduler-mcp", "context.json");
    const miaAppContextPath = path.join(runtimeDir, "mia-app-mcp", "context.json");

    assert.ok(fs.existsSync(schedulerContextPath), "scheduler MCP context.json was not written");
    assert.ok(fs.existsSync(miaAppContextPath), "Mia-app MCP context.json was not written");

    const schedulerCtx = JSON.parse(fs.readFileSync(schedulerContextPath, "utf8"));
    assert.deepEqual(schedulerCtx, {
      botId: "botX",
      sessionId: "sess-77",
      originMessageId: "umsg-123"
    });

    const miaAppCtx = JSON.parse(fs.readFileSync(miaAppContextPath, "utf8"));
    assert.equal(miaAppCtx.botId, "botX");
    assert.equal(miaAppCtx.sessionId, "sess-77");
    assert.equal(miaAppCtx.originMessageId, "umsg-123");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
