const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createCloudClient } = require("../src/shared/cloud-client");

const ROOT = path.join(__dirname, "..");

test("api(): GET 带 Bearer,无 clientOpId", async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ ok: 1 }) };
  };
  const client = createCloudClient({ apiBase: "https://c.test", fetchImpl: fakeFetch, getToken: () => "T" });
  const data = await client.api("/api/me");
  assert.equal(data.ok, 1);
  assert.equal(calls[0].url, "https://c.test/api/me");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer T");
  assert.equal(calls[0].opts.body, undefined);
});

test("api(): POST 对象 body 自动注入 clientOpId 并 JSON 序列化", async () => {
  let seen;
  const fakeFetch = async (url, opts) => { seen = opts; return { ok: true, status: 200, json: async () => ({}) }; };
  const client = createCloudClient({ apiBase: "https://c.test", fetchImpl: fakeFetch, getToken: () => "", idFactory: () => "op_fixed" });
  await client.api("/api/x", { method: "POST", body: { a: 1 } });
  const parsed = JSON.parse(seen.body);
  assert.equal(parsed.a, 1);
  assert.equal(parsed.clientOpId, "op_fixed");
  assert.equal(seen.headers.Authorization, undefined);
});

test("api(): 预置 clientOpId 不被覆盖", async () => {
  let seen;
  const fakeFetch = async (url, opts) => { seen = opts; return { ok: true, status: 200, json: async () => ({}) }; };
  const client = createCloudClient({ apiBase: "https://c.test", fetchImpl: fakeFetch, getToken: () => "", idFactory: () => "op_new" });
  await client.api("/api/x", { method: "PUT", body: { clientOpId: "op_keep" } });
  assert.equal(JSON.parse(seen.body).clientOpId, "op_keep");
});

test("api(): 非 2xx 抛出 data.error", async () => {
  const fakeFetch = async () => ({ ok: false, status: 403, json: async () => ({ error: "no" }) });
  const client = createCloudClient({ apiBase: "https://c.test", fetchImpl: fakeFetch, getToken: () => "" });
  await assert.rejects(() => client.api("/api/x"), /no/);
});

test("eventsUrl(): http→ws, https→wss, 带 since_seq", () => {
  const { eventsUrlFor } = require("../src/shared/cloud-client");
  assert.equal(eventsUrlFor("https://c.test", 7), "wss://c.test/api/events?since_seq=7");
  assert.equal(eventsUrlFor("http://c.test", 0), "ws://c.test/api/events?since_seq=0");
});

test("backoffMs(): 指数退避并封顶 30s", () => {
  const { backoffMs } = require("../src/shared/cloud-client");
  assert.equal(backoffMs(0), 1000);
  assert.equal(backoffMs(1), 2000);
  assert.equal(backoffMs(2), 4000);
  assert.equal(backoffMs(10), 30000);
});

test("WS 客户端:连接用 mia-token subprotocol,分发 message,断线调度重连", () => {
  const { createCloudClient } = require("../src/shared/cloud-client");
  const sockets = [];
  class FakeWS {
    constructor(url, protocols) { this.url = url; this.protocols = protocols; this.listeners = {}; sockets.push(this); }
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
    close() { this.closed = true; (this.listeners.close || []).forEach((fn) => fn({})); }
    emit(t, ev) { (this.listeners[t] || []).forEach((fn) => fn(ev)); }
  }
  const scheduled = [];
  const got = [];
  const client = createCloudClient({
    apiBase: "https://c.test", fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    getToken: () => "TK", WebSocketImpl: FakeWS,
    scheduleReconnect: (fn) => scheduled.push(fn)
  });
  client.connectEvents({ sinceSeq: () => 3, onEvent: (e) => got.push(e) });
  assert.equal(sockets[0].url, "wss://c.test/api/events?since_seq=3");
  assert.deepEqual(sockets[0].protocols, ["mia-token.TK"]);
  sockets[0].emit("message", { data: JSON.stringify({ type: "x", seq: 4 }) });
  assert.equal(got[0].type, "x");
  sockets[0].emit("close", {});
  assert.equal(scheduled.length, 1);
});

test("mobile RN API types use canonical bot sender and identity fields", () => {
  const source = fs.readFileSync(path.join(ROOT, "apps/mobile-rn/src/api/types.ts"), "utf8");

  assert.match(source, /export type SenderKind = "user" \| "bot" \| "system";/);
  assert.match(source, /type\?: "dm" \| "group" \| "bot" \| string;/);
  assert.match(source, /bot_id\?: string;/);
  assert.match(source, /botId\?: string;/);
  assert.match(source, /decorations\?: \{ botId\?: string; botName\?: string; runtimeKind\?: string \};/);
  assert.match(source, /identity\?: \{ avatar\?: AvatarDescriptor; statusBadge\?: StatusBadge \| null \};/);
  assert.match(source, /member_kind\?: "user" \| "bot" \| string;/);
  assert.match(source, /bot_name\?: string;/);
  assert.match(source, /bot_avatar_image\?: string;/);
  assert.match(source, /bot_avatar_crop\?: Record<string, unknown> \| null;/);
  assert.match(source, /identity\?: Identity;/);
  assert.doesNotMatch(source, /export type SenderKind = "user" \| "fellow" \| "system";/);
  assert.doesNotMatch(source, /fellow_id\?: string;/);
  assert.doesNotMatch(source, /fellowKey\?: string;/);
  assert.doesNotMatch(source, /fellow_name\?: string;/);
  assert.doesNotMatch(source, /fellow_avatar_image\?: string;/);
});

test("mobile RN message fixtures and normalization use sender_kind bot", () => {
  const normalizeSource = fs.readFileSync(path.join(ROOT, "apps/mobile-rn/src/logic/normalizeMessage.ts"), "utf8");
  const conversationListSource = fs.readFileSync(path.join(ROOT, "apps/mobile-rn/src/logic/conversationList.ts"), "utf8");
  const botMessageFixture = { id: "m_bot", sender_kind: "bot", sender_ref: "bot_mia", body_md: "hi" };
  const botConversationFixture = { id: "botc_user_bot_mia", type: "bot", bot_id: "bot_mia" };

  assert.equal(botMessageFixture.sender_kind, "bot");
  assert.equal(botConversationFixture.bot_id, "bot_mia");
  assert.match(normalizeSource, /m\.sender_kind === "bot" \? "assistant"/);
  assert.doesNotMatch(normalizeSource, /m\.sender_kind === "fellow" \? "assistant"/);
  assert.match(conversationListSource, /bots\?: Bot\[]/);
  assert.match(conversationListSource, /conversationListTitle\(c, bots\)/);
});
