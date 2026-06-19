const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createHermesRunsClient } = require("../src/cloud-agent/hermes-runs-client.js");

test("runChat passes bot display name and persona instructions to Hermes", async () => {
  const requests = [];
  const client = createHermesRunsClient({
    async fetch(url, options = {}) {
      requests.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
      if (String(url).endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run_1" }), { status: 200 });
      }
      return new Response("data: {\"type\":\"run.completed\",\"content\":\"ok\"}\n\n", { status: 200 });
    }
  });

  await client.runChat({
    baseUrl: "http://worker",
    apiKey: "k",
    userId: "user_1",
    conversationId: "g_1",
    bot: {
      id: "bot_kongling",
      displayName: "空铃",
      personaText: "你是空铃，群聊里的 Bot。"
    },
    input: "空铃在干啥"
  });

  assert.equal(requests[0].body.metadata.display_name, "空铃");
  assert.equal(requests[0].body.metadata.bot_id, "bot_kongling");
  assert.equal(requests[0].body.instructions, "你是空铃，群聊里的 Bot。");
});

test("runChat sends image attachments as native Hermes multimodal content parts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-hermes-run-image-"));
  try {
    const imagePath = path.join(dir, "shot.png");
    fs.writeFileSync(imagePath, Buffer.from("fakepng"));
    const requests = [];
    const client = createHermesRunsClient({
      async fetch(url, options = {}) {
        requests.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
        if (String(url).endsWith("/v1/runs")) {
          return new Response(JSON.stringify({ run_id: "run_img" }), { status: 200 });
        }
        return new Response("data: {\"type\":\"run.completed\",\"content\":\"ok\"}\n\n", { status: 200 });
      }
    });

    await client.runChat({
      baseUrl: "http://worker",
      apiKey: "k",
      userId: "user_1",
      conversationId: "g_1",
      bot: { id: "bot_vision", displayName: "Vision" },
      input: "看看这张图",
      attachments: [{
        id: "file_img",
        name: "shot.png",
        mimeType: "image/png",
        size: 7,
        kind: "image",
        path: "/data/attachments/run_img/1-shot.png",
        hostPath: imagePath
      }]
    });

    const input = requests[0].body.input;
    assert.equal(Array.isArray(input), true);
    assert.equal(input[0].role, "user");
    assert.equal(input[0].content[0].type, "text");
    assert.match(input[0].content[0].text, /看看这张图/);
    assert.match(input[0].content[0].text, /\[Image attached at: \/data\/attachments\/run_img\/1-shot\.png\]/);
    assert.equal(input[0].content[1].type, "image_url");
    assert.equal(input[0].content[1].image_url.url, `data:image/png;base64,${Buffer.from("fakepng").toString("base64")}`);
    assert.equal(requests[0].body.attachments[0].hostPath, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readEvents parses SSE split across stream chunks and surfaces approval.request live", async () => {
  const seen = [];
  const client = createHermesRunsClient({
    async fetch(url) {
      if (String(url).endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run_x" }), { status: 200 });
      }
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          // approval.request is split mid-token across two chunks to prove buffering.
          controller.enqueue(enc.encode('data: {"event":"approval.request","run_id":"run_x","choi'));
          controller.enqueue(enc.encode('ces":["once","deny"]}\n\ndata: {"type":"message.delta","delta":"he"}\n\n'));
          controller.enqueue(enc.encode('data: {"type":"message.delta","delta":"llo"}\n\ndata: {"type":"run.completed","content":"hello"}\n\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
  });

  const result = await client.runChat({
    baseUrl: "http://worker",
    apiKey: "k",
    userId: "u",
    conversationId: "c",
    bot: { id: "bot_f", displayName: "F" },
    input: "hi",
    onEvent: (event) => seen.push(event.event || event.type)
  });

  assert.deepEqual(seen, ["approval.request", "message.delta", "message.delta", "run.completed"]);
  assert.equal(result.content, "hello");
});

test("submitApproval POSTs the choice to the run approval endpoint", async () => {
  const calls = [];
  const client = createHermesRunsClient({
    async fetch(url, options = {}) {
      calls.push({ url: String(url), method: options.method, body: options.body ? JSON.parse(options.body) : null });
      return new Response(JSON.stringify({ object: "hermes.run.approval_response", resolved: 1 }), { status: 200 });
    }
  });

  const res = await client.submitApproval({ baseUrl: "http://worker", apiKey: "k", runId: "run_x", choice: "once" });

  assert.equal(calls[0].url, "http://worker/v1/runs/run_x/approval");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, { choice: "once" });
  assert.equal(res.resolved, 1);
});
