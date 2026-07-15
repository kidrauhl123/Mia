const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("mobile scan web stores the approved session and opens Mia Web", async () => {
  const source = fs.readFileSync(path.join(root, "src/web/mobile-scan.js"), "utf8");
  const elements = new Map(["scanTitle", "scanDetail", "scanSpinner", "scanRetry"].map((id) => [id, {
    textContent: "",
    hidden: false,
    addEventListener() {}
  }]));
  const requests = [];
  const storage = new Map();
  const redirects = [];
  const historyPaths = [];

  const responses = [
    { ok: true, requestId: "msr_1", status: "pending", expiresAt: "2099-01-01T00:00:00.000Z" },
    { ok: true, status: "approved", token: "session_token", user: { id: "u_1" } }
  ];
  const context = {
    URL,
    document: {
      title: "扫码登录 Mia Web",
      getElementById: (id) => elements.get(id)
    },
    navigator: {
      userAgent: "Mozilla/5.0 (iPhone) Mobile MicroMessenger/8.0.50",
      platform: "iPhone",
      maxTouchPoints: 1
    },
    location: {
      href: "https://mia.test/mobile-scan?grant=ms_1",
      replace: (value) => redirects.push(value),
      reload() {}
    },
    history: {
      replaceState: (_state, _title, value) => historyPaths.push(value)
    },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value)
    },
    fetch: async (pathname, options) => {
      requests.push({ pathname, body: JSON.parse(options.body) });
      const payload = responses.shift();
      return { ok: true, status: 200, json: async () => payload };
    },
    setTimeout,
    clearTimeout
  };

  vm.runInNewContext(source, context, { filename: "mobile-scan.js" });
  for (let attempt = 0; attempt < 10 && redirects.length === 0; attempt += 1) await tick();

  assert.equal(requests[0].pathname, "/api/auth/mobile-scan/request");
  assert.equal(requests[0].body.grant, "ms_1");
  assert.equal(requests[0].body.clientKind, "wechat-web");
  assert.equal(requests[1].pathname, "/api/auth/mobile-scan/complete");
  assert.deepEqual(JSON.parse(storage.get("mia.web.session")), {
    token: "session_token",
    user: { id: "u_1" },
    theme: "light"
  });
  assert.deepEqual(historyPaths, ["/mobile-scan"]);
  assert.deepEqual(redirects, ["/app/"]);
});
