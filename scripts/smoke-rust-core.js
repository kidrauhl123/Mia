"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");

const LISTENING_PREFIX = "MIA_CORE_LISTENING ";
const root = path.resolve(__dirname, "..");

function fail(message) {
  throw new Error(message);
}

function waitForListening(child, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for Mia Core startup.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith(LISTENING_PREFIX)) continue;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(trimmed.slice(LISTENING_PREFIX.length)));
        } catch (error) {
          reject(error);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Mia Core exited before startup: code=${code} signal=${signal}\nstderr:\n${stderr}`));
    });
  });
}

async function requestJson(baseUrl, method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${route} failed ${response.status}: ${text}`);
  }
  return parsed;
}

function waitForWsEvent(url, predicate = () => true, triggerAfterReady = null, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let triggered = false;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out waiting for WebSocket event from ${url}`));
    }, timeoutMs);
    socket.on("message", (data) => {
      let event;
      try {
        event = JSON.parse(String(data));
      } catch (error) {
        clearTimeout(timer);
        socket.close();
        reject(error);
        return;
      }
      if (!triggered && triggerAfterReady && event.name === "system.statusChanged") {
        triggered = true;
        Promise.resolve()
          .then(triggerAfterReady)
          .catch((error) => {
            clearTimeout(timer);
            socket.close();
            reject(error);
          });
      }
      if (!predicate(event)) return;
      clearTimeout(timer);
      socket.close();
      resolve(event);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (!triggered && triggerAfterReady) {
        reject(new Error(`WebSocket closed before trigger ran for ${url}`));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-smoke-"));
  const workspaceDir = path.join(dataDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const cargo = process.env.MIA_CARGO_BIN || "cargo";
  const child = spawn(cargo, [
    "run",
    "-p",
    "mia-core-app",
    "--",
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--data-dir",
    dataDir,
    "--workspace-dir",
    workspaceDir,
    "--language",
    "zh"
  ], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const listening = await waitForListening(child);
    const baseUrl = `http://${listening.host || "127.0.0.1"}:${listening.port}`;
    const wsUrl = `ws://${listening.host || "127.0.0.1"}:${listening.port}/ws`;

    const health = await requestJson(baseUrl, "GET", "/health");
    if (!health?.ok) fail("/health did not return ok");

    const event = await waitForWsEvent(wsUrl, (candidate) => candidate.name === "system.statusChanged");
    if (event.name !== "system.statusChanged") fail(`/ws returned unexpected event ${event.name}`);

    const provider = await requestJson(baseUrl, "POST", "/api/providers", {
      id: "openai-smoke",
      kind: "openai",
      displayName: "OpenAI Smoke",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKey: "smoke-secret",
      apiMode: "responses",
      authType: "api_key",
      models: ["gpt-5"],
      enabled: true
    });
    if (provider?.provider?.id !== "openai-smoke") fail("provider create did not return provider.id");
    const resolvedProvider = await requestJson(baseUrl, "POST", "/api/providers/resolve", {
      config: { providerConnectionId: "openai-smoke", model: "gpt-5" },
      context: { engine: "hermes" }
    });
    if (resolvedProvider?.runtime?.providerConnectionId !== "openai-smoke") {
      fail("provider resolve did not return Core-owned runtime config");
    }

    const bot = await requestJson(baseUrl, "POST", "/api/bots", {
      displayName: "Smoke Bot",
      identity: { persona: "smoke" },
      capabilities: { tools: true }
    });
    const botId = bot?.bot?.id;
    if (!botId) fail("bot create did not return bot.id");

    let conversation;
    const conversationEvent = await waitForWsEvent(
      wsUrl,
      (candidate) => candidate.name === "conversation.created",
      async () => {
        conversation = await requestJson(baseUrl, "POST", "/api/conversations", {
          kind: "direct",
          title: "Smoke Conversation",
          botId,
          metadata: {
            runtime: { engine: "mock-agent" },
            workspaceDir
          }
        });
      }
    );
    const conversationId = conversation?.conversation?.id;
    if (!conversationId) fail("conversation create did not return conversation.id");
    if (conversationEvent?.data?.conversation?.id !== conversationId) {
      fail("conversation.created event did not match created conversation");
    }

    const message = await requestJson(baseUrl, "POST", `/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
      body: "hello smoke",
      attachments: [],
      selectedSkillIds: ["skill_smoke"]
    });
    if (!message?.turnId || !message?.assistantMessageId) {
      fail("message send did not return Core-owned turn and assistant message ids");
    }

    const task = await requestJson(baseUrl, "POST", "/api/tasks/jobs", {
      kind: "agent",
      schedule: { type: "oneshot", at: new Date(Date.now() + 60000).toISOString() },
      target: { botId, conversationId },
      instructions: "smoke task"
    });
    const taskId = task?.job?.id;
    if (!taskId) fail("task create did not return job.id");
    let taskRun;
    const taskRunFinished = await waitForWsEvent(
      wsUrl,
      (candidate) => candidate.name === "task.runFinished",
      async () => {
        taskRun = await requestJson(baseUrl, "POST", `/api/tasks/jobs/${encodeURIComponent(taskId)}/run`, {});
      }
    );
    if (!taskRun?.messageId || !taskRun?.turnId || taskRun?.conversationId !== conversationId) {
      fail("task run did not execute through Core conversation orchestration");
    }
    if (taskRunFinished?.data?.jobId !== taskId || taskRunFinished?.data?.ok !== true) {
      fail("task.runFinished event did not match completed task run");
    }

    const autoTask = await requestJson(baseUrl, "POST", "/api/tasks/jobs", {
      kind: "agent",
      schedule: { type: "oneshot", at: new Date(Date.now() + 1500).toISOString() },
      target: { botId, conversationId },
      instructions: "automatic scheduler smoke"
    });
    const autoTaskId = autoTask?.job?.id;
    if (!autoTaskId) fail("automatic task create did not return job.id");
    const autoTaskFinished = await waitForWsEvent(
      wsUrl,
      (candidate) => (
        candidate.name === "task.runFinished" &&
        candidate?.data?.jobId === autoTaskId &&
        candidate?.data?.scheduled === true
      ),
      null,
      15000
    );
    if (autoTaskFinished?.data?.ok !== true || autoTaskFinished?.data?.conversationId !== conversationId) {
      fail("automatic scheduler task did not execute through Core conversation orchestration");
    }

    const mcpScript = `
while IFS= read -r line; do
  case "$line" in
    *\\"method\\":\\"initialize\\"*)
      printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"smoke-mcp","version":"1.0.0"}}}'
      ;;
    *\\"method\\":\\"tools/list\\"*)
      printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"smoke_tool","description":"Smoke test tool","inputSchema":{"type":"object"}}]}}'
      ;;
  esac
done
`;
    const mcp = await requestJson(baseUrl, "POST", "/api/mcp/servers", {
      name: "smoke-mcp",
      enabled: false,
      transport: {
        type: "stdio",
        command: "sh",
        args: ["-c", mcpScript]
      }
    });
    const mcpId = mcp?.server?.id;
    if (!mcpId) fail("mcp create did not return server.id");
    const mcpTest = await requestJson(baseUrl, "POST", `/api/mcp/servers/${encodeURIComponent(mcpId)}/test`, {});
    if (!mcpTest?.ok) fail("mcp test did not return ok");
    if (mcpTest?.diagnostic?.tools?.[0]?.name !== "smoke_tool") {
      fail("mcp test did not return the smoke MCP tool manifest");
    }

    console.log(`Rust Core smoke passed at ${baseUrl}`);
  } finally {
    child.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
