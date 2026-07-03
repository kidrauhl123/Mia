const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  anthropicToOpenAiChatBody,
  createClaudeCodeMiaProxy
} = require("../src/main/claude-code-mia-proxy.js");

function jsonResponse(payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    arrayBuffer: async () => body
  };
}

function sseEvents(text) {
  return String(text || "")
    .split(/\r?\n\r?\n/)
    .map((frame) => {
      const lines = frame.split(/\r?\n/);
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "";
      const data = lines.find((line) => line.startsWith("data:"))?.slice(5).trim() || "";
      if (!event || !data) return null;
      return { event, data: JSON.parse(data) };
    })
    .filter(Boolean);
}

test("anthropicToOpenAiChatBody maps messages, tools, and the Mia model override", () => {
  const converted = anthropicToOpenAiChatBody({
    model: "claude-sonnet-4-5",
    system: "system rules",
    max_tokens: 128,
    messages: [
      { role: "user", content: [{ type: "text", text: "run pwd" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll check." },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pwd" } }
        ]
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "/repo" }] }]
      }
    ],
    tools: [{ name: "Bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
    tool_choice: { type: "tool", name: "Bash" }
  }, { model: "mia-auto" });

  assert.equal(converted.model, "mia-auto");
  assert.equal(converted.max_tokens, 128);
  assert.deepEqual(converted.messages[0], { role: "system", content: "system rules" });
  assert.deepEqual(converted.messages[1], { role: "user", content: "run pwd" });
  assert.equal(converted.messages[2].role, "assistant");
  assert.equal(converted.messages[2].tool_calls[0].function.name, "Bash");
  assert.equal(converted.messages[2].tool_calls[0].function.arguments, "{\"command\":\"pwd\"}");
  assert.deepEqual(converted.messages[3], { role: "tool", tool_call_id: "toolu_1", content: "/repo" });
  assert.equal(converted.tools[0].function.name, "Bash");
  assert.deepEqual(converted.tool_choice, { type: "function", function: { name: "Bash" } });
});

test("anthropicToOpenAiChatBody does not force a tool while Anthropic thinking is enabled", () => {
  const converted = anthropicToOpenAiChatBody({
    model: "claude-sonnet-4-5",
    thinking: { type: "enabled", budget_tokens: 4096 },
    messages: [{ role: "user", content: "搜索一下今天的新闻" }],
    tools: [{
      name: "WebSearch",
      description: "Search the web.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      }
    }],
    tool_choice: { type: "tool", name: "WebSearch" }
  }, { model: "mia-auto" });

  assert.equal(converted.model, "mia-auto");
  assert.equal(converted.tools[0].function.name, "WebSearch");
  assert.equal(converted.tool_choice, "auto");
});

test("Mia Claude proxy forwards Anthropic messages to chat completions", async (t) => {
  let upstreamCall = null;
  const proxy = createClaudeCodeMiaProxy({
    appendLog: () => {},
    fetch: async (url, options = {}) => {
      upstreamCall = {
        url: String(url),
        headers: options.headers || {},
        body: JSON.parse(String(options.body || "{}"))
      };
      return jsonResponse({
        id: "chatcmpl_1",
        model: "deepseek-chat",
        choices: [{ message: { role: "assistant", content: "mia-ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 }
      });
    }
  });
  t.after(() => proxy.stop());

  const session = await proxy.createSession({
    baseUrl: "https://mia.example/api/me/model-proxy/v1",
    apiKey: "cloud-token",
    model: "mia-auto"
  });
  const response = await fetch(`${session.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.authToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }]
    })
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.type, "message");
  assert.equal(payload.content[0].text, "mia-ok");
  assert.equal(payload.usage.input_tokens, 5);
  assert.equal(payload.usage.output_tokens, 2);
  assert.equal(upstreamCall.url, "https://mia.example/api/me/model-proxy/v1/chat/completions");
  assert.equal(upstreamCall.headers.authorization, "Bearer cloud-token");
  assert.equal(upstreamCall.body.model, "mia-auto");
  assert.deepEqual(upstreamCall.body.messages, [{ role: "user", content: "hello" }]);
});

test("Mia Claude proxy converts OpenAI chat streams to Anthropic SSE", async (t) => {
  const encoder = new TextEncoder();
  const proxy = createClaudeCodeMiaProxy({
    appendLog: () => {},
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "text/event-stream" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}\n\n"));
          controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"llo\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":2}}\n\n"));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      })
    })
  });
  t.after(() => proxy.stop());

  const session = await proxy.createSession({
    baseUrl: "https://mia.example/api/me/model-proxy/v1",
    apiKey: "cloud-token",
    model: "mia-auto"
  });
  const response = await fetch(`${session.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.authToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      stream: true,
      model: "claude-sonnet-4-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }]
    })
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(text, /event: message_start/);
  assert.match(text, /"type":"text_delta","text":"he"/);
  assert.match(text, /"type":"text_delta","text":"llo"/);
  assert.match(text, /event: message_delta/);
  assert.match(text, /"output_tokens":2/);
  assert.match(text, /event: message_stop/);
});

test("Mia Claude proxy streams tool call arguments as Anthropic input_json_delta", async (t) => {
  const encoder = new TextEncoder();
  const proxy = createClaudeCodeMiaProxy({
    appendLog: () => {},
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "text/event-stream" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_search\",\"function\":{\"name\":\"WebSearch\",\"arguments\":\"{\\\"query\\\":\"}}]}}]}\n\n"));
          controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"搜索国际新闻周报\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":4}}\n\n"));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      })
    })
  });
  t.after(() => proxy.stop());

  const session = await proxy.createSession({
    baseUrl: "https://mia.example/api/me/model-proxy/v1",
    apiKey: "cloud-token",
    model: "mia-auto"
  });
  const response = await fetch(`${session.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.authToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      stream: true,
      model: "claude-sonnet-4-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "搜索国际新闻周报" }],
      tools: [{
        name: "WebSearch",
        description: "Search the web.",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"]
        }
      }]
    })
  });
  const events = sseEvents(await response.text());
  const toolStart = events.find((item) => item.event === "content_block_start" && item.data.content_block?.type === "tool_use");
  const inputDelta = events.find((item) => item.event === "content_block_delta" && item.data.delta?.type === "input_json_delta");

  assert.equal(response.status, 200);
  assert.deepEqual(toolStart.data.content_block, {
    type: "tool_use",
    id: "call_search",
    name: "WebSearch",
    input: {}
  });
  assert.equal(inputDelta.data.index, toolStart.data.index);
  assert.equal(inputDelta.data.delta.partial_json, "{\"query\":\"搜索国际新闻周报\"}");
});
