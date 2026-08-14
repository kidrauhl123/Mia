const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { createMiaCloudServer } = require("../scripts/serve-cloud.js");
const {
  callTool,
  readContext,
  toolDefinitionsForMode
} = require("../src/cloud-agent/mia-cloud-mcp-server.js");
const { loginCloudUser } = require("./helpers/cloud-auth.js");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

test("cloud Mia MCP exposes single memory tool and current skills without desktop Core", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-mcp-"));
  const contextPath = path.join(tmp, "context.json");
  let mutateBody = null;
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, "Bearer test-token");
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/me/memory-documents/mutate");
      mutateBody = await readJson(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        action: mutateBody.action,
        target: mutateBody.target,
        currentEntries: [mutateBody.content],
        usedChars: mutateBody.content.length,
        limitChars: 2200,
        usagePercent: 1,
        noOp: false,
        error: null,
        suggestion: null
      }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  let serverStarted = false;
  fs.writeFileSync(contextPath, JSON.stringify({
    userId: "user_1",
    botId: "writer",
    conversationId: "conv_1",
    sessionId: "conv_1",
    originMessageId: "msg_1",
    memoryMode: "mia",
    enabledSkillIds: ["flashcards"],
    skills: [
      {
        id: "flashcards",
        name: "Anki 记忆卡",
        description: "生成记忆卡。",
        body: "# STEM Flashcard Generation"
      }
    ]
  }, null, 2));

  try {
    await listen(server);
    serverStarted = true;
    const address = server.address();
    const env = {
      MIA_CLOUD_MCP_CONTEXT_FILE: contextPath,
      MIA_CLOUD_URL: `http://${address.address}:${address.port}`,
      MIA_CLOUD_TOKEN: "test-token"
    };
    const ctx = readContext({ env });
    assert.equal(ctx.botId, "writer");

    const names = toolDefinitionsForMode({ env }).map((tool) => tool.name);
    assert.deepEqual(names.filter((name) => name.startsWith("memory")), ["memory"]);
    assert.equal(names.includes("memory_search"), false);
    assert.equal(names.includes("web_search"), false);
    assert.equal(names.includes("web_fetch"), false);
    const memoryDefinition = toolDefinitionsForMode({ env }).find((tool) => tool.name === "memory");
    assert.equal(Object.hasOwn(memoryDefinition.inputSchema.properties, "target"), false);
    assert.deepEqual(memoryDefinition.inputSchema.required, ["action"]);

    const remembered = await callTool("memory", {
      action: "add",
      target: "user",
      content: "Writer answers in Chinese."
    }, { env });
    assert.equal(remembered.success, true);
    assert.equal(Object.hasOwn(remembered, "target"), false);
    assert.equal(Object.hasOwn(remembered, "currentEntries"), false);
    assert.deepEqual(mutateBody, {
      conversationId: "conv_1",
      botId: "writer",
      action: "add",
      target: "memory",
      content: "Writer answers in Chinese."
    });

    const listed = await callTool("skill_list_current", {}, { env });
    assert.deepEqual(listed.skills, [{
      id: "flashcards",
      name: "Anki 记忆卡",
      description: "生成记忆卡。"
    }]);

    const skill = await callTool("skill_read_current", { id: "mia:flashcards" }, { env });
    assert.equal(skill.skill.id, "flashcards");
    assert.match(skill.skill.body, /STEM Flashcard Generation/);

    const snapshot = await callTool("context_snapshot", {}, { env });
    assert.equal(snapshot.botId, "writer");
    assert.equal(snapshot.sessionId, "conv_1");
    assert.equal(snapshot.memoryMode, "mia");
    assert.deepEqual(snapshot.memoryTools, { enabled: true, memory: "memory" });
    assert.equal(Object.hasOwn(snapshot, "memories"), false);
  } finally {
    if (serverStarted) await close(server);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("cloud Mia MCP hides memory tool in native mode", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-mcp-native-"));
  const contextPath = path.join(tmp, "context.json");
  fs.writeFileSync(contextPath, JSON.stringify({ memoryMode: "native" }), "utf8");
  try {
    const env = { MIA_CLOUD_MCP_CONTEXT_FILE: contextPath };
    const names = toolDefinitionsForMode({ env }).map((tool) => tool.name);
    assert.equal(names.includes("memory"), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("cloud Mia MCP delegates to another group Bot through the authenticated cloud route", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-mcp-team-"));
  const contextPath = path.join(tmp, "context.json");
  let received = null;
  const server = http.createServer(async (req, res) => {
    received = { method: req.method, url: req.url, body: await readJson(req) };
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "queued", targets: [{ botId: "bot_research" }] }));
  });
  let serverStarted = false;
  fs.writeFileSync(contextPath, JSON.stringify({
    userId: "user_1",
    botId: "bot_host",
    conversationId: "g_team",
    originMessageId: "msg_root",
    delegationDepth: 1,
    memoryMode: "mia"
  }));
  try {
    await listen(server);
    serverStarted = true;
    const address = server.address();
    const env = {
      MIA_CLOUD_MCP_CONTEXT_FILE: contextPath,
      MIA_CLOUD_URL: `http://${address.address}:${address.port}`,
      MIA_CLOUD_TOKEN: "team-token"
    };
    const definition = toolDefinitionsForMode({ env }).find((tool) => tool.name === "team_send_message");
    assert.deepEqual(definition.inputSchema.required, ["to", "message"]);
    const result = await callTool("team_send_message", {
      to: "研究员",
      message: "核对这组数据"
    }, { env });
    assert.equal(result.status, "queued");
    assert.deepEqual(received, {
      method: "POST",
      url: "/api/conversations/g_team/delegations",
      body: {
        fromBotId: "bot_host",
        to: "研究员",
        message: "核对这组数据",
        originMessageId: "msg_root",
        delegationDepth: 1
      }
    });
  } finally {
    if (serverStarted) await close(server);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("cloud Mia MCP exposes conversation-scoped scheduler tools backed by cloud tasks", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-mcp-scheduler-"));
  const contextPath = path.join(tmp, "context.json");
  const requests = [];
  const tasks = [{
    id: "task_foreign",
    title: "Foreign task",
    botId: "other_bot",
    conversationId: "other_conversation",
    trigger: { type: "cron", cron: "0 9 * * *" },
    timezone: "UTC",
    prompt: "foreign",
    status: "active"
  }];
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, "Bearer scheduler-token");
      const body = req.method === "GET" || req.method === "DELETE" ? null : await readJson(req);
      requests.push({ method: req.method, url: req.url, body });
      let payload = null;
      let status = 200;
      if (req.method === "GET" && req.url === "/api/tasks") {
        payload = { tasks };
      } else if (req.method === "POST" && req.url === "/api/tasks") {
        const task = {
          id: "task_current",
          title: body.title,
          botId: body.botId,
          conversationId: body.conversationId,
          sessionId: body.sessionId,
          originMessageId: body.originMessageId,
          scheduleDescription: body.scheduleDescription,
          trigger: body.trigger || { type: "oneshot", at: "2026-08-10T03:02:00.000Z" },
          timezone: body.timezone,
          prompt: body.prompt,
          status: "active",
          nextFireAt: Date.parse("2026-08-10T03:02:00.000Z")
        };
        tasks.push(task);
        status = 201;
        payload = { task };
      } else if (req.method === "PATCH" && req.url === "/api/tasks/task_current") {
        const task = tasks.find((item) => item.id === "task_current");
        if (body.title) task.title = body.title;
        if (Object.hasOwn(body, "scheduleDescription")) task.scheduleDescription = body.scheduleDescription;
        if (body.prompt) task.prompt = body.prompt;
        if (body.trigger) task.trigger = body.trigger;
        if (body.status) task.status = body.status;
        payload = { task };
      } else if (req.method === "DELETE" && req.url === "/api/tasks/task_current") {
        const index = tasks.findIndex((item) => item.id === "task_current");
        tasks.splice(index, 1);
        payload = { ok: true };
      } else {
        status = 404;
        payload = { error: `unexpected ${req.method} ${req.url}` };
      }
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  let serverStarted = false;
  fs.writeFileSync(contextPath, JSON.stringify({
    userId: "user_1",
    botId: "writer",
    conversationId: "conv_1",
    sessionId: "conv_1",
    originMessageId: "msg_1"
  }), "utf8");

  try {
    await listen(server);
    serverStarted = true;
    const address = server.address();
    const env = {
      MIA_CLOUD_MCP_CONTEXT_FILE: contextPath,
      MIA_CLOUD_URL: `http://${address.address}:${address.port}`,
      MIA_CLOUD_TOKEN: "scheduler-token"
    };
    const definitions = toolDefinitionsForMode({ env });
    const scheduleNames = definitions.map((tool) => tool.name).filter((name) => name.startsWith("schedule_"));
    assert.deepEqual(scheduleNames, [
      "schedule_list_current",
      "schedule_create",
      "schedule_update",
      "schedule_delete"
    ]);
    const createDefinition = definitions.find((tool) => tool.name === "schedule_create");
    assert.deepEqual(createDefinition.inputSchema.required, ["name", "schedule", "scheduleDescription", "message"]);
    assert.equal(createDefinition.annotations.readOnlyHint, false);
    assert.equal(definitions.find((tool) => tool.name === "schedule_delete").annotations.destructiveHint, true);

    const created = await callTool("schedule_create", {
      name: "吃饭提醒",
      schedule: "in 2 minutes",
      scheduleDescription: "2 分钟后",
      message: "用一句简短中文提醒用户吃饭。",
      botId: "spoofed",
      conversationId: "spoofed"
    }, { env });
    assert.equal(created.job.id, "task_current");
    assert.equal(created.job.scheduleDescription, "2 分钟后");
    const createRequest = requests.find((request) => request.method === "POST" && request.url === "/api/tasks");
    assert.deepEqual(createRequest.body, {
      title: "吃饭提醒",
      botId: "writer",
      conversationId: "conv_1",
      sessionId: "conv_1",
      originMessageId: "msg_1",
      schedule: "in 2 minutes",
      scheduleDescription: "2 分钟后",
      timezone: "Asia/Shanghai",
      fireMode: "agent",
      prompt: "用一句简短中文提醒用户吃饭。"
    });

    const listed = await callTool("schedule_list_current", {}, { env });
    assert.deepEqual(listed.jobs.map((job) => job.id), ["task_current"]);
    assert.equal(listed.jobs[0].scheduleDescription, "2 分钟后");

    const updated = await callTool("schedule_update", {
      jobId: "task_current",
      name: "午饭提醒",
      schedule: { type: "cron", cron: "0 12 * * *" },
      scheduleDescription: "每天中午 12 点",
      status: "paused"
    }, { env });
    assert.equal(updated.job.name, "午饭提醒");
    assert.equal(updated.job.schedule, "0 12 * * *");
    assert.equal(updated.job.scheduleDescription, "每天中午 12 点");
    assert.equal(updated.job.status, "paused");
    const patchRequest = requests.find((request) => request.method === "PATCH");
    assert.deepEqual(patchRequest.body, {
      title: "午饭提醒",
      scheduleDescription: "每天中午 12 点",
      trigger: { type: "cron", cron: "0 12 * * *" },
      status: "paused"
    });

    const descriptionOnlyUpdated = await callTool("schedule_update", {
      jobId: "task_current",
      scheduleDescription: "工作日中午 12 点"
    }, { env });
    assert.equal(descriptionOnlyUpdated.job.scheduleDescription, "工作日中午 12 点");
    const descriptionPatchRequest = requests.filter((request) => request.method === "PATCH").at(-1);
    assert.deepEqual(descriptionPatchRequest.body, { scheduleDescription: "工作日中午 12 点" });
    const listedAfterDescriptionUpdate = await callTool("schedule_list_current", {}, { env });
    assert.equal(listedAfterDescriptionUpdate.jobs[0].scheduleDescription, "工作日中午 12 点");

    await assert.rejects(
      callTool("schedule_delete", { jobId: "task_foreign" }, { env }),
      /not found in this conversation/
    );
    assert.equal(requests.some((request) => request.method === "DELETE" && request.url.includes("task_foreign")), false);

    const deleted = await callTool("schedule_delete", { jobId: "task_current" }, { env });
    assert.deepEqual(deleted, { ok: true, jobId: "task_current" });
    const afterDelete = await callTool("schedule_list_current", {}, { env });
    assert.deepEqual(afterDelete.jobs, []);
  } finally {
    if (serverStarted) await close(server);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("cloud Mia MCP delegation route wakes the selected group Bot", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-mcp-team-flow-"));
  const contextPath = path.join(tmp, "context.json");
  const agentCalls = [];
  const server = createMiaCloudServer({
    dataDir: path.join(tmp, "cloud-data"),
    cloudAgentWorkerManager: {
      async ensureWorker(userId) {
        return { userId, baseUrl: "http://worker", apiKey: "worker-key", gatewayWsUrl: "ws://worker/api/ws" };
      }
    },
    cloudAgentClient: {
      async runChat(args) {
        agentCalls.push(args);
        return { runId: "run-team-mcp", content: "核对完成", events: [] };
      }
    }
  });
  let serverStarted = false;
  try {
    await listen(server);
    serverStarted = true;
    const address = server.address();
    const userId = loginCloudUser(server.mia.cloudStore, "mcp_team_flow").user.id;
    for (const [id, name] of [["bot_host", "主持人"], ["bot_research", "研究员"]]) {
      server.mia.botsStore.upsertBot(userId, { id, displayName: name });
      server.mia.runtimeBindingsStore.upsertBinding({
        userId,
        botId: id,
        runtimeKind: "cloud-claude-code",
        activate: true,
        config: { model: "mia-default" }
      });
    }
    const conversation = server.mia.socialStore.createConversation({
      id: "g_mcp_team",
      type: "group",
      name: "Team"
    });
    server.mia.socialStore.addConversationMember({ conversationId: conversation.id, memberKind: "user", memberRef: userId });
    server.mia.socialStore.addConversationMember({ conversationId: conversation.id, memberKind: "bot", memberRef: "bot_host", ownerId: userId });
    server.mia.socialStore.addConversationMember({ conversationId: conversation.id, memberKind: "bot", memberRef: "bot_research", ownerId: userId });
    fs.writeFileSync(contextPath, JSON.stringify({
      userId,
      botId: "bot_host",
      conversationId: conversation.id,
      originMessageId: "msg_root",
      delegationDepth: 0
    }));
    const result = await callTool("team_send_message", {
      to: "研究员",
      message: "核对这组数据"
    }, {
      env: {
        MIA_CLOUD_MCP_CONTEXT_FILE: contextPath,
        MIA_CLOUD_URL: `http://${address.address}:${address.port}`,
        MIA_CLOUD_TOKEN: server.mia.cloudStore.createSessionForUser(userId).token
      }
    });
    assert.equal(result.status, "queued");
    await server.mia.cloudAgentDispatcher.idle();
    assert.equal(agentCalls.length, 1);
    assert.equal(agentCalls[0].bot.id, "bot_research");
    assert.equal(server.mia.messagesStore.listLatestMessages(conversation.id, 20).messages.at(-1).body_md, "核对完成");
  } finally {
    if (serverStarted) await server.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("cloud Mia MCP creates a durable task that fires back into the same bot conversation", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-mcp-scheduler-flow-"));
  const contextPath = path.join(tmp, "context.json");
  const agentCalls = [];
  const server = createMiaCloudServer({
    dataDir: path.join(tmp, "cloud-data"),
    cloudAgentWorkerManager: {
      async ensureWorker(userId) {
        return { userId, baseUrl: "http://worker", apiKey: "worker-key", gatewayWsUrl: "ws://worker/api/ws" };
      }
    },
    cloudAgentClient: {
      async runChat(args) {
        agentCalls.push(args);
        return { runId: "run-scheduled-mcp", content: "到点吃饭了。", events: [] };
      }
    }
  });
  let serverStarted = false;
  try {
    await listen(server);
    serverStarted = true;
    const address = server.address();
    const baseUrl = `http://${address.address}:${address.port}`;
    const account = loginCloudUser(server.mia.cloudStore, "mcp_scheduler_flow");
    const userId = account.user.id;
    server.mia.botsStore.upsertBot(userId, {
      id: "meal_bot",
      displayName: "Meal Bot",
      personaText: "You remind the user."
    });
    server.mia.runtimeBindingsStore.upsertBinding({
      userId,
      botId: "meal_bot",
      runtimeKind: "cloud-claude-code",
      activate: true,
      config: { model: "mia-default" }
    });
    const conversation = server.mia.socialStore.createConversation({
      id: `botc_${userId}_meal_bot`,
      type: "bot",
      name: "Meal Bot",
      decorations: { botId: "meal_bot" }
    });
    server.mia.socialStore.addConversationMember({
      conversationId: conversation.id,
      memberKind: "user",
      memberRef: userId
    });
    server.mia.socialStore.addConversationMember({
      conversationId: conversation.id,
      memberKind: "bot",
      memberRef: "meal_bot",
      ownerId: userId
    });
    fs.writeFileSync(contextPath, JSON.stringify({
      userId,
      botId: "meal_bot",
      conversationId: conversation.id,
      sessionId: conversation.id,
      originMessageId: "origin_meal_reminder"
    }), "utf8");
    const env = {
      MIA_CLOUD_MCP_CONTEXT_FILE: contextPath,
      MIA_CLOUD_URL: baseUrl,
      MIA_CLOUD_TOKEN: server.mia.cloudStore.createSessionForUser(userId).token
    };

    const before = Date.now();
    const created = await callTool("schedule_create", {
      name: "吃饭提醒",
      schedule: "in 2 minutes",
      scheduleDescription: "2 分钟后",
      message: "用一句简短中文提醒用户吃饭。"
    }, { env });
    assert.match(created.job.id, /^t-/);

    const tasks = server.mia.cloudTasksService.list(userId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].botId, "meal_bot");
    assert.equal(tasks[0].conversationId, conversation.id);
    assert.equal(tasks[0].originMessageId, "origin_meal_reminder");
    assert.equal(tasks[0].scheduleDescription, "2 分钟后");
    assert.equal(tasks[0].trigger.type, "oneshot");
    assert.ok(Date.parse(tasks[0].trigger.at) >= before + 119_000);

    const listed = await callTool("schedule_list_current", {}, { env });
    assert.deepEqual(listed.jobs.map((job) => job.id), [tasks[0].id]);
    assert.equal(listed.jobs[0].scheduleDescription, "2 分钟后");

    const updated = await callTool("schedule_update", {
      jobId: tasks[0].id,
      scheduleDescription: "3 分钟后"
    }, { env });
    assert.equal(updated.job.scheduleDescription, "3 分钟后");
    assert.equal(server.mia.cloudTasksService.get(userId, tasks[0].id).scheduleDescription, "3 分钟后");

    await server.mia.cloudTasksService.runNow(userId, tasks[0].id);
    assert.equal(agentCalls.length, 1);
    assert.match(agentCalls[0].input, /提醒用户吃饭/);
    const messages = server.mia.messagesStore.listMessagesSince(conversation.id, 0, 20);
    assert.deepEqual(messages.map((message) => [message.sender_kind, message.body_md]), [
      ["bot", "到点吃饭了。"]
    ]);
    const after = server.mia.cloudTasksService.get(userId, tasks[0].id);
    assert.equal(after.runs.length, 1);
    assert.equal(after.runs[0].status, "ok");
  } finally {
    if (serverStarted) await close(server);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
