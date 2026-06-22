const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  chatResponseToResponses,
  createCodexMiaProxy,
  responsesToChatCompletions
} = require("../src/main/codex-mia-proxy.js");

function historySession() {
  return {
    model: "mia-auto",
    responseCalls: new Map(),
    responseOrder: [],
    callIndex: new Map()
  };
}

test("responsesToChatCompletions converts Codex Responses input and tools to Chat Completions", () => {
  const converted = responsesToChatCompletions({
    model: "gpt-5-codex",
    instructions: "You are Codex.",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }]
    }],
    tools: [{
      type: "function",
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    }],
    tool_choice: "auto",
    stream: true
  }, { model: "mia-auto" });

  assert.equal(converted.body.model, "mia-auto");
  assert.deepEqual(converted.body.messages, [
    { role: "system", content: "You are Codex." },
    { role: "user", content: "hello" }
  ]);
  assert.equal(converted.body.tools[0].function.name, "read_file");
  assert.equal(converted.body.stream_options.include_usage, true);
});

test("chatResponseToResponses records tool calls so follow-up tool outputs can be restored", () => {
  const session = historySession();
  const response = chatResponseToResponses({
    id: "chatcmpl_1",
    created: 1,
    model: "mia-auto",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" }
        }]
      }
    }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
  }, {}, session);

  assert.equal(response.output[0].type, "function_call");

  const converted = responsesToChatCompletions({
    model: "gpt-5-codex",
    previous_response_id: response.id,
    input: [{
      type: "function_call_output",
      call_id: "call_1",
      output: "file text"
    }]
  }, session);

  assert.equal(converted.body.messages[0].role, "assistant");
  assert.equal(converted.body.messages[0].tool_calls[0].id, "call_1");
  assert.equal(converted.body.messages[1].role, "tool");
  assert.equal(converted.body.messages[1].tool_call_id, "call_1");
});

test("responsesToChatCompletions upgrades single tool output objects when restoring cached calls", () => {
  const session = historySession();
  const response = chatResponseToResponses({
    id: "chatcmpl_2",
    created: 1,
    model: "mia-auto",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_single",
          type: "function",
          function: { name: "read_file", arguments: "{}" }
        }]
      }
    }]
  }, {}, session);

  const converted = responsesToChatCompletions({
    model: "gpt-5-codex",
    previous_response_id: response.id,
    input: {
      type: "function_call_output",
      call_id: "call_single",
      output: "ok"
    }
  }, session);

  assert.equal(converted.body.messages[0].role, "assistant");
  assert.equal(converted.body.messages[1].role, "tool");
  assert.equal(converted.body.messages[1].content, "ok");
});

test("Codex Mia proxy forwards Responses requests to Mia Chat Completions and returns Responses JSON", async () => {
  const calls = [];
  const proxy = createCodexMiaProxy({
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
      return new Response(JSON.stringify({
        id: "chatcmpl_1",
        created: 1,
        model: "mia-auto",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "你好。" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const session = await proxy.createSession({
    baseUrl: "https://mia.example/api/me/model-proxy/v1",
    apiKey: "cloud-token",
    model: "mia-auto"
  });
  try {
    const response = await fetch(`${session.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: "gpt-5-codex", input: "hello" })
    });
    const json = await response.json();

    assert.equal(calls[0].url, "https://mia.example/api/me/model-proxy/v1/chat/completions");
    assert.equal(calls[0].headers.authorization, "Bearer cloud-token");
    assert.equal(calls[0].body.model, "mia-auto");
    assert.deepEqual(calls[0].body.messages, [{ role: "user", content: "hello" }]);
    assert.equal(json.object, "response");
    assert.equal(json.output[0].content[0].text, "你好。");
  } finally {
    await proxy.stop();
  }
});

test("Codex Mia proxy converts streaming Chat Completions SSE to Responses SSE", async () => {
  const proxy = createCodexMiaProxy({
    fetch: async () => new Response([
      "data: {\"id\":\"chatcmpl_1\",\"created\":1,\"model\":\"mia-auto\",\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n",
      "data: {\"id\":\"chatcmpl_1\",\"created\":1,\"model\":\"mia-auto\",\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n",
      "data: {\"id\":\"chatcmpl_1\",\"created\":1,\"model\":\"mia-auto\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n",
      "data: [DONE]\n\n"
    ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } })
  });
  const session = await proxy.createSession({
    baseUrl: "https://mia.example/api/me/model-proxy/v1",
    apiKey: "cloud-token",
    model: "mia-auto"
  });
  try {
    const response = await fetch(`${session.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: "gpt-5-codex", input: "hello", stream: true })
    });
    const text = await response.text();

    assert.match(text, /event: response\.created/);
    assert.match(text, /event: response\.output_text\.delta/);
    assert.match(text, /"delta":"你"/);
    assert.match(text, /"text":"你好"/);
    assert.match(text, /event: response\.completed/);
  } finally {
    await proxy.stop();
  }
});
