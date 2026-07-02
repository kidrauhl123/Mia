# Local Hermes Approval And Attachment Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local Hermes show a working permission approval banner and make uploaded file attachments reach Hermes as concrete local paths.

**Architecture:** Local Hermes should reuse Mia's existing `agentPermissionCoordinator` instead of adding a second renderer approval system. Attachment handling should be verified at the boundary that matters: the final Hermes `/v1/runs` payload must include the materialized file path, not only the original `/api/files/...` reference or a guessed `/Users/jung/<name>` path.

**Tech Stack:** Electron main process, Node test runner, Hermes Runs API, Mia social run events, existing `createAgentPermissionCoordinator`.

## Global Constraints

- Do not change global approval UI semantics; reuse `permission_request` / `permission_resolved` for local engines.
- Do not route local Hermes approval decisions through cloud `/api/conversations/:id/runs/:runId/approval`.
- Keep cloud Hermes `approval.request` behavior intact.
- Do not add a new renderer banner shape unless the existing permission banner cannot represent the request.
- Tests must cover the local Hermes path, not only cloud Hermes.

---

### Task 1: Add Local Hermes Approval Unit Coverage

**Files:**
- Modify: `tests/hermes-run-service.test.js`
- Modify: `tests/hermes-chat-adapter.test.js`

**Interfaces:**
- Consumes: `createHermesRunService().readRunEventStream({ runId, signal, emit, runtimeContext, onApprovalRequest })`
- Produces: a failing test proving local Hermes pauses on `approval.request` and calls an injected approval handler before continuing.

- [ ] **Step 1: Write the failing run-service test**

Add this test to `tests/hermes-run-service.test.js`:

```js
test("readRunEventStream surfaces approval.request to the local approval handler before continuing", async () => {
  const calls = [];
  const enc = new TextEncoder();
  const service = createHermesRunService({
    baseUrl: () => "http://hermes.test",
    apiKey: () => "secret",
    normalizeAttachments: (attachments) => Array.isArray(attachments) ? attachments : [],
    attachmentContext: () => "",
    fetch: async (url) => {
      assert.equal(String(url), "http://hermes.test/v1/runs/run_approval/events");
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode('data: {"event":"approval.request","run_id":"run_approval","tool":"terminal","command":"python3 read_docx.py"}\n\n'));
          controller.enqueue(enc.encode('data: {"event":"message.delta","delta":"done"}\n\n'));
          controller.enqueue(enc.encode('data: {"event":"run.completed","content":"done"}\n\n'));
          controller.close();
        }
      }), { status: 200 });
    }
  });

  const emitted = [];
  const result = await service.readRunEventStream({
    runId: "run_approval",
    signal: null,
    emit: (kind, data) => emitted.push({ kind, data }),
    onApprovalRequest: async ({ runId, event }) => {
      calls.push({ runId, event });
      return { ok: true };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].runId, "run_approval");
  assert.equal(calls[0].event.tool, "terminal");
  assert.equal(calls[0].event.command, "python3 read_docx.py");
  assert.equal(result.content, "done");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test tests/hermes-run-service.test.js
```

Expected: FAIL because `readRunEventStream` ignores `approval.request` and has no `onApprovalRequest` hook.

- [ ] **Step 3: Write the failing adapter test**

Add this test to `tests/hermes-chat-adapter.test.js`:

```js
test("sendChat resolves Hermes approval requests through the permission coordinator", async () => {
  const permissionCalls = [];
  const approvalPosts = [];
  const deps = createDeps({
    permissionCoordinator: {
      requestPermission: async (request) => {
        permissionCalls.push(request);
        return { decision: "allow", scope: "once" };
      }
    },
    submitRunApproval: async (input) => {
      approvalPosts.push(input);
      return { ok: true };
    },
    readRunEventStream: async ({ runId, onApprovalRequest }) => {
      await onApprovalRequest({
        runId,
        event: {
          event: "approval.request",
          run_id: runId,
          tool: "terminal",
          command: "python3 read_docx.py"
        }
      });
      return { content: "done", finishReason: "stop", events: [] };
    }
  });
  const adapter = createHermesChatAdapter(deps);
  const emitted = [];

  const result = await adapter.sendChat({
    bot,
    sessionId: "s1",
    messages: [{ role: "user", content: "read file" }],
    emit: (kind, data) => emitted.push({ kind, data })
  });

  assert.equal(result.choices[0].message.content, "done");
  assert.equal(permissionCalls.length, 1);
  assert.equal(permissionCalls[0].engine, "hermes");
  assert.equal(permissionCalls[0].toolName, "terminal");
  assert.equal(permissionCalls[0].input.command, "python3 read_docx.py");
  assert.equal(typeof permissionCalls[0].emit, "function");
  assert.deepEqual(approvalPosts, [{ runId: "run_1", choice: "once" }]);
});
```

- [ ] **Step 4: Run the adapter test to verify it fails**

Run:

```bash
node --test tests/hermes-chat-adapter.test.js
```

Expected: FAIL because `createHermesChatAdapter` does not accept `permissionCoordinator`, does not pass `onApprovalRequest`, and does not POST approval decisions.

### Task 2: Implement Local Hermes Approval Plumbing

**Files:**
- Modify: `src/main/hermes-run-service.js`
- Modify: `src/main/hermes-chat-adapter.js`
- Modify: `src/core/mia-core.js`
- Modify: `src/main.js`

**Interfaces:**
- Produces: `readRunEventStream({ ..., onApprovalRequest })` calls the hook live for `approval.request`.
- Produces: `createHermesRunService().submitRunApproval({ runId, choice, all })`.
- Produces: `createHermesChatAdapter({ permissionCoordinator, submitRunApproval })`.

- [ ] **Step 1: Add approval event handling to `hermes-run-service`**

In `src/main/hermes-run-service.js`, inside `readRunEventStream`, handle approval events before `run.completed`:

```js
if (name === "approval.request") {
  if (emit) emit("approval.request", payload);
  if (typeof onApprovalRequest === "function") {
    await onApprovalRequest({ runId, event: payload });
  }
  return false;
}
if (name === "approval.responded") {
  if (emit) emit("approval.responded", payload);
  return false;
}
```

Change `consumeFrame` to `async`, and await it in both frame-consumption loops.

- [ ] **Step 2: Add `submitRunApproval` to `hermes-run-service`**

Add this function to `createHermesRunService` and export it in the returned object:

```js
async function submitRunApproval({ runId, choice, all = false, signal } = {}) {
  const id = String(runId || "").trim();
  if (!id) throw new Error("Hermes run id is required.");
  const selectedChoice = String(choice || "").trim();
  if (!selectedChoice) throw new Error("Hermes approval choice is required.");
  const response = await fetchImpl(`${baseUrl()}/v1/runs/${encodeURIComponent(id)}/approval`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`
    },
    body: JSON.stringify({ choice: selectedChoice, ...(all ? { all: true } : {}) }),
    signal
  });
  const text = await response.text();
  if (!response.ok) throw new Error(firstTextValue(safeJson(text)) || text || `Hermes approval failed: ${response.status}`);
  try { return JSON.parse(text); } catch { return { ok: true }; }
}
```

If `safeJson` does not exist, implement it locally:

```js
function safeJson(text) {
  try { return JSON.parse(String(text || "")); } catch { return null; }
}
```

- [ ] **Step 3: Translate local permission decisions in `hermes-chat-adapter`**

In `src/main/hermes-chat-adapter.js`, accept:

```js
const permissionCoordinator = deps.permissionCoordinator || null;
const submitRunApproval = deps.submitRunApproval || null;
```

Add helpers:

```js
function approvalPreview(event = {}) {
  for (const key of ["command", "cmd", "preview", "reason", "detail", "description", "message"]) {
    if (typeof event[key] === "string" && event[key].trim()) return event[key].trim();
  }
  const data = event.data && typeof event.data === "object" ? event.data : null;
  return data ? approvalPreview(data) : "";
}

function approvalToolName(event = {}) {
  return String(event.tool || event.tool_name || event.name || event.data?.tool || "tool").trim() || "tool";
}

function hermesChoiceForPermissionDecision(decision = {}) {
  if (decision.decision !== "allow") return "deny";
  if (decision.scope === "always") return "always";
  if (decision.scope === "session") return "session";
  return "once";
}
```

Pass this to `readRunEventStream`:

```js
onApprovalRequest: async ({ runId, event }) => {
  if (!permissionCoordinator || typeof permissionCoordinator.requestPermission !== "function") {
    throw new Error("Hermes requested tool approval, but no permission coordinator is available.");
  }
  if (!submitRunApproval || typeof submitRunApproval !== "function") {
    throw new Error("Hermes requested tool approval, but approval submission is unavailable.");
  }
  const preview = approvalPreview(event);
  const decision = await permissionCoordinator.requestPermission({
    engine: "hermes",
    botKey: bot.key,
    botName: bot.name,
    sessionId,
    toolName: approvalToolName(event),
    input: {
      command: preview,
      approval: event
    },
    emit,
    signal
  });
  await submitRunApproval({
    runId,
    choice: hermesChoiceForPermissionDecision(decision),
    signal
  });
}
```

- [ ] **Step 4: Wire dependencies**

In `src/core/mia-core.js`, add these dependencies to `createHermesChatAdapter`:

```js
permissionCoordinator: agentPermissionCoordinator,
submitRunApproval: hermesRunService.submitRunApproval,
```

In `src/main.js`, add the same pair to the Electron main-process Hermes adapter construction.

- [ ] **Step 5: Run approval tests**

Run:

```bash
node --test tests/hermes-run-service.test.js tests/hermes-chat-adapter.test.js tests/agent-permission-coordinator.test.js tests/renderer-social.test.js
```

Expected: PASS.

### Task 3: Lock The Attachment Path Boundary

**Files:**
- Modify: `tests/local-bot-responder.test.js`
- Modify: `tests/hermes-chat-adapter.test.js`
- Modify only if tests fail: `src/main/social/local-bot-responder.js`, `src/main/hermes-run-service.js`, `src/main/hermes-chat-adapter.js`

**Interfaces:**
- Consumes: `materializeResponderAttachments(...)`
- Produces: a test proving Hermes `/v1/runs` receives `input` containing `本地路径：<materialized path>`.

- [ ] **Step 1: Add a local responder to Hermes payload integration test**

Add a test that runs `createLocalBotResponder` with a real Hermes adapter configured with a fake `/v1/runs` fetch. The assertion must inspect the JSON body sent to `/v1/runs` and require:

```js
assert.match(body.input, /附件上下文/);
assert.match(body.input, /本地路径：/);
assert.match(body.input, /业务信息调查表\.docx/);
assert.doesNotMatch(body.input, /\/Users\/jung\/业务信息调查表\.docx/);
```

- [ ] **Step 2: Run the test and inspect failure**

Run:

```bash
node --test tests/local-bot-responder.test.js tests/hermes-chat-adapter.test.js
```

Expected: FAIL if the current production path drops the materialized attachment before Hermes payload construction.

- [ ] **Step 3: Fix the exact failing boundary**

If the test shows `currentUserAttachments` has the path but `runBody.input` does not, fix `src/main/hermes-run-service.js` attachment normalization/context.

If the test shows `currentUserAttachments` does not have the path, fix `src/main/social/local-bot-responder.js` materialization or `fetchFileAttachment` wiring.

If the test shows the path exists in `runBody.input` but Hermes still guesses `/Users/jung/...`, add a stronger instruction to the attachment context in `src/main/chat-attachments.js`:

```js
"必须使用上面列出的“本地路径”逐字读取附件；不要根据文件名猜测 /Users、Downloads 或当前工作目录中的路径。"
```

- [ ] **Step 4: Add regression assertion for follow-up turns**

Add a `local-bot-responder` test for a second user message such as `"允许"` after an attachment message. It should prove either:

1. The second turn includes prior attachment context, or
2. The first turn never needs a second approval for plain attachment parsing because the local file path is already valid and approval plumbing works.

Prefer option 2 for this bug; only preserve historical attachment paths if the product explicitly supports multi-turn attachment references.

### Task 4: Verification

**Files:**
- No production files unless previous tasks require fixes.

**Interfaces:**
- Produces: confidence that local Hermes approvals and attachment paths are no longer regressions.

- [ ] **Step 1: Run targeted tests**

```bash
node --test tests/hermes-run-service.test.js tests/hermes-chat-adapter.test.js tests/local-bot-responder.test.js tests/agent-permission-coordinator.test.js tests/renderer-social.test.js
```

Expected: PASS.

- [ ] **Step 2: Run main-process syntax/check**

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 3: Manual reproduction**

Open Mia, start a fresh Hermes private conversation, upload `业务信息调查表.docx`, and verify:

- The tool trace uses a materialized attachment path, not `/Users/jung/业务信息调查表.docx`.
- If Hermes requests terminal approval, the existing Mia permission banner appears.
- Clicking approve resumes the same Hermes run.
- The final reply contains parsed docx content or a specific file-read error, not “本地模型这次没有产生任何文本回复”.

## Self-Review

- Spec coverage: covers local Hermes approval event ingest, local approval decision submission, dependency wiring, renderer reuse, attachment payload contract, and manual reproduction.
- Placeholder scan: no task depends on an unspecified file or unnamed interface.
- Type consistency: `onApprovalRequest`, `submitRunApproval`, and `permissionCoordinator.requestPermission` signatures are defined before use.
