const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  contentBlocksWithDisplayText,
  contentBlocksWithFinalText,
  createStreamingTextSmoother,
  createAssistantContentBlockCollector,
  displayTextFromContentBlocks,
  normalizeContentBlocks
} = require("../src/shared/assistant-content-blocks.js");

test("collector preserves thinking, text, tool, text order", () => {
  const collector = createAssistantContentBlockCollector();

  collector.collect("reasoning_delta", { id: "think_1", text: "检查上下文" });
  collector.collect("text_delta", { id: "msg_1", text: "我先看目录。" });
  collector.collect("tool_call_started", { id: "tool_1", name: "shell", preview: "pwd" });
  collector.collect("tool_call_completed", { id: "tool_1", name: "shell", duration: 1.25 });
  collector.collect("text_delta", { id: "msg_2", text: "结论是线上目录已确认。" });

  assert.deepEqual(collector.payload(), [
    {
      type: "thinking",
      id: "think_1",
      text: "检查上下文",
      status: "running",
      duration: null
    },
    { type: "text", id: "msg_1", text: "我先看目录。" },
    {
      type: "tool",
      id: "tool_1",
      name: "shell",
      preview: "pwd",
      status: "completed",
      duration: 1.25,
      error: false
    },
    { type: "text", id: "msg_2", text: "结论是线上目录已确认。" }
  ]);
});

test("collector accepts Hermes gateway event names for thinking and tool blocks", () => {
  const collector = createAssistantContentBlockCollector();

  collector.collect("reasoning.delta", { id: "think_1", text: "推理中" });
  collector.collect("thinking.delta", { id: "think_2", text: "再想一步" });
  collector.collect("tool.start", { id: "tool_1", name: "shell", preview: "pwd" });
  collector.collect("tool.progress", { id: "tool_1", delta: "pwd\n/Users/jung" });
  collector.collect("tool.complete", { id: "tool_1", name: "shell", duration: 0.75 });

  assert.deepEqual(collector.payload(), [
    {
      type: "thinking",
      id: "think_1",
      text: "推理中再想一步",
      status: "running",
      duration: null
    },
    {
      type: "tool",
      id: "tool_1",
      name: "shell",
      preview: "pwd\n/Users/jung",
      status: "completed",
      duration: 0.75,
      error: false
    }
  ]);
});

test("collector merges adjacent thinking deltas with token-scoped ids into one block", () => {
  const collector = createAssistantContentBlockCollector();

  collector.collect("thinking.delta", { id: "tok_1", text: "the" });
  collector.collect("thinking.delta", { id: "tok_2", text: " user" });
  collector.collect("thinking.delta", { id: "tok_3", text: " has" });
  collector.collect("thinking.delta", { id: "tok_4", text: " two" });

  assert.deepEqual(collector.payload(), [
    {
      type: "thinking",
      id: "tok_1",
      text: "the user has two",
      status: "running",
      duration: null
    }
  ]);
});

test("collector merges adjacent thinking deltas without ids into one block", () => {
  const collector = createAssistantContentBlockCollector();

  collector.collect("thinking.delta", { text: "( ˘˘)♡ analyzing..." });
  collector.collect("thinking.delta", { text: "The" });
  collector.collect("thinking.delta", { text: " user" });
  collector.collect("thinking.delta", { text: " is" });

  assert.deepEqual(collector.payload(), [
    {
      type: "thinking",
      id: "thinking_0",
      text: "( ˘˘)♡ analyzing...The user is",
      status: "running",
      duration: null
    }
  ]);
});

test("collector records text blocks from Hermes message.delta events", () => {
  const collector = createAssistantContentBlockCollector();

  collector.collect("message.delta", { id: "msg_1", text: "来自 Hermes 的文本" });

  assert.deepEqual(collector.payload(), [
    { type: "text", id: "msg_1", text: "来自 Hermes 的文本" }
  ]);
});

test("collector preserves agent-provided recap blocks without generating them", () => {
  const collector = createAssistantContentBlockCollector();

  collector.collect("text_delta", { id: "msg_1", text: "先给答案。" });
  collector.collect("recap", {
    id: "recap_1",
    text: "You asked how to share phone VPN; use a same-WiFi HTTP proxy."
  });

  assert.deepEqual(collector.payload(), [
    { type: "text", id: "msg_1", text: "先给答案。" },
    {
      type: "recap",
      id: "recap_1",
      text: "You asked how to share phone VPN; use a same-WiFi HTTP proxy."
    }
  ]);
});

test("collector preserves file edit blocks in the same ordered stream", () => {
  const collector = createAssistantContentBlockCollector();

  collector.collect("text_delta", { id: "text_1", text: "我先改文件。" });
  collector.collect("file_edit", {
    id: "edit_1",
    path: "src/web/app.js",
    action: "update",
    diff: "@@\n-old\n+new",
    additions: 1,
    deletions: 1,
    status: "completed"
  });
  collector.collect("text_delta", { id: "text_2", text: "改完了。" });

  assert.deepEqual(collector.payload(), [
    { type: "text", id: "text_1", text: "我先改文件。" },
    {
      type: "file_edit",
      id: "edit_1",
      path: "src/web/app.js",
      action: "update",
      title: "Edited src/web/app.js (+1 -1)",
      diff: "@@\n-old\n+new",
      additions: 1,
      deletions: 1,
      status: "completed",
      error: false
    },
    { type: "text", id: "text_2", text: "改完了。" }
  ]);
});

test("collector replaces empty Editing files tool rows with the file edit block", () => {
  const collector = createAssistantContentBlockCollector();

  collector.collect("tool_call_started", { id: "tool_1", name: "Editing files" });
  collector.collect("tool_call_completed", { id: "tool_1", name: "Editing files", status: "completed" });
  collector.collect("file_edit", {
    id: "tool_1_diff_0",
    toolCallId: "tool_1",
    path: "src/web/app.js",
    action: "update",
    diff: "@@\n-old\n+new",
    additions: 1,
    deletions: 1,
    status: "completed"
  });

  assert.deepEqual(collector.payload(), [
    {
      type: "file_edit",
      id: "tool_1_diff_0",
      path: "src/web/app.js",
      action: "update",
      title: "Edited src/web/app.js (+1 -1)",
      diff: "@@\n-old\n+new",
      additions: 1,
      deletions: 1,
      status: "completed",
      error: false
    }
  ]);
});

test("normalizer keeps only valid ordered content blocks", () => {
  assert.deepEqual(normalizeContentBlocks([
    { type: "text", id: "t1", text: "hello" },
    { type: "text", id: "empty", text: "   " },
    { type: "thinking", id: "r1", status: "done", duration: 2.5 },
    { type: "tool", id: "bad" },
    { type: "tool", id: "ok", name: "search", status: "failed", preview: "q" },
    { type: "file_edit", id: "edit_1", path: "src/a.js", action: "add", diff: "+x", additions: 1 }
  ]), [
    { type: "text", id: "t1", text: "hello" },
    { type: "thinking", id: "r1", status: "completed", duration: 2.5 },
    {
      type: "tool",
      id: "ok",
      name: "search",
      preview: "q",
      status: "error",
      duration: null,
      error: false
    },
    {
      type: "file_edit",
      id: "edit_1",
      path: "src/a.js",
      action: "add",
      title: "Added src/a.js (+1 -0)",
      diff: "+x",
      additions: 1,
      deletions: 0,
      status: "running",
      error: false
    }
  ]);
});

test("normalizer merges adjacent persisted thinking blocks", () => {
  assert.deepEqual(normalizeContentBlocks([
    { type: "thinking", id: "tok_1", text: "the", status: "running" },
    { type: "thinking", id: "tok_2", text: " user", status: "running" },
    { type: "thinking", id: "tok_3", text: " has", status: "running" },
    { type: "thinking", id: "tok_4", text: " two", status: "running" }
  ]), [
    {
      type: "thinking",
      id: "tok_1",
      text: "the user has two",
      status: "running",
      duration: null
    }
  ]);
});

test("collector splits thinking content when a tool interrupts the same id", () => {
  const collector = createAssistantContentBlockCollector();

  collector.collect("reasoning_delta", { id: "think_1", text: "alpha" });
  collector.collect("reasoning_delta", { id: "think_1", text: "beta" });
  collector.collect("tool_call_started", { id: "tool_1", name: "shell" });
  collector.collect("reasoning_delta", { id: "think_1", text: "gamma" });

  assert.deepEqual(collector.payload().map((block) => block.type), ["thinking", "tool", "thinking"]);
  assert.equal(collector.payload()[0].text, "alphabeta");
  assert.equal(collector.payload()[2].text, "gamma");
});

test("collector applies thinking completion updates without creating an empty block", () => {
  const collector = createAssistantContentBlockCollector();

  collector.collect("reasoning_delta", { id: "think_1", text: "alpha" });
  collector.collect("tool_call_started", { id: "tool_1", name: "shell" });
  collector.collect("thinking.completed", { id: "think_1", duration: 4.2 });

  const blocks = collector.payload();
  assert.deepEqual(blocks.map((block) => block.type), ["thinking", "tool"]);
  assert.equal(blocks[0].status, "completed");
  assert.equal(blocks[0].duration, 4.2);
});

test("collector appends final text when it was not streamed as a text block", () => {
  const collector = createAssistantContentBlockCollector();

  collector.collect("text_delta", { id: "text_1", text: "我先看目录。" });
  collector.collect("tool_call_started", { id: "tool_1", name: "shell" });
  collector.collect("tool_call_completed", { id: "tool_1", name: "shell" });

  assert.deepEqual(collector.payload("结论是已确认。"), [
    { type: "text", id: "text_1", text: "我先看目录。" },
    { type: "tool", id: "tool_1", name: "shell", preview: "", status: "completed", duration: null, error: false },
    { type: "text", id: "text_final_2", text: "结论是已确认。" }
  ]);
});

test("collector merges adjacent text deltas without ids into one final text block", () => {
  const collector = createAssistantContentBlockCollector();

  collector.collect("text_delta", { text: "聊" });
  collector.collect("text_delta", { text: "的" });
  collector.collect("text_delta", { text: "或者" });
  collector.collect("text_delta", { text: "需要我帮忙的，随时说~" });

  assert.deepEqual(collector.payload("聊的或者需要我帮忙的，随时说~"), [
    { type: "text", id: "text_0", text: "聊的或者需要我帮忙的，随时说~" }
  ]);
});

test("final text completion adds only the missing suffix when body includes streamed text", () => {
  assert.deepEqual(contentBlocksWithFinalText([
    { type: "text", id: "text_1", text: "我先看目录。" }
  ], "我先看目录。\n\n结论是已确认。"), [
    { type: "text", id: "text_1", text: "我先看目录。" },
    { type: "text", id: "text_final_1", text: "结论是已确认。" }
  ]);
});

test("final text completion does not duplicate existing final content", () => {
  assert.deepEqual(contentBlocksWithFinalText([
    { type: "text", id: "text_1", text: "结论是已确认。" }
  ], "结论是已确认。"), [
    { type: "text", id: "text_1", text: "结论是已确认。" }
  ]);
});

test("final text completion does not append the full body when text blocks already match with separator whitespace", () => {
  assert.deepEqual(contentBlocksWithFinalText([
    { type: "text", id: "text_1", text: "我先试试。" },
    { type: "tool", id: "tool_1", name: "shell", preview: "curl", status: "completed", duration: null, error: false },
    { type: "text", id: "text_2", text: "\n\n还是不行。" }
  ], "我先试试。\n\n还是不行。"), [
    { type: "text", id: "text_1", text: "我先试试。" },
    { type: "tool", id: "tool_1", name: "shell", preview: "curl", status: "completed", duration: null, error: false },
    { type: "text", id: "text_2", text: "\n\n还是不行。" }
  ]);
});

test("final text completion suppresses a whitespace-reflowed integrated summary across multiple text blocks", () => {
  assert.deepEqual(contentBlocksWithFinalText([
    { type: "text", id: "text_1", text: "Let me check the current state of the workspace to understand what's happening." },
    { type: "tool", id: "tool_1", name: "Read file", preview: "", status: "completed", duration: null, error: false },
    { type: "text", id: "text_2", text: "看起来工作区有一些 Mia 首页相关的文件（mia-homepage-v2.html）和一些设计素材。" }
  ], "Let me check the current state of the workspace to understand what's happening.看起来工作区有一些 Mia 首页相关的文件（mia-homepage-v2.html）和一些设计素材。"), [
    { type: "text", id: "text_1", text: "Let me check the current state of the workspace to understand what's happening." },
    { type: "tool", id: "tool_1", name: "Read file", preview: "", status: "completed", duration: null, error: false },
    { type: "text", id: "text_2", text: "看起来工作区有一些 Mia 首页相关的文件（mia-homepage-v2.html）和一些设计素材。" }
  ]);
});

test("final text completion keeps only the genuinely new suffix after a whitespace-reflowed process summary", () => {
  assert.deepEqual(contentBlocksWithFinalText([
    { type: "text", id: "text_1", text: "我先检查。" },
    { type: "tool", id: "tool_1", name: "shell", preview: "pwd", status: "completed", duration: null, error: false },
    { type: "text", id: "text_2", text: "看起来工作区有一些文件。" }
  ], "我先检查。看起来工作区有一些文件。\n\n需要我帮你做什么？"), [
    { type: "text", id: "text_1", text: "我先检查。" },
    { type: "tool", id: "tool_1", name: "shell", preview: "pwd", status: "completed", duration: null, error: false },
    { type: "text", id: "text_2", text: "看起来工作区有一些文件。" },
    { type: "text", id: "text_final_3", text: "需要我帮你做什么？" }
  ]);
});

test("final text completion strips a legacy duplicated text_final block before rendering", () => {
  assert.deepEqual(contentBlocksWithFinalText([
    { type: "text", id: "text_1", text: "我先试试。" },
    { type: "tool", id: "tool_1", name: "shell", preview: "curl", status: "completed", duration: null, error: false },
    { type: "text", id: "text_2", text: "\n\n还是不行。" },
    { type: "text", id: "text_final_3", text: "我先试试。\n\n还是不行。" }
  ], "我先试试。\n\n还是不行。"), [
    { type: "text", id: "text_1", text: "我先试试。" },
    { type: "tool", id: "tool_1", name: "shell", preview: "curl", status: "completed", duration: null, error: false },
    { type: "text", id: "text_2", text: "\n\n还是不行。" }
  ]);
});

test("final text completion strips a whitespace-reflowed legacy duplicated text_final block before rendering", () => {
  assert.deepEqual(contentBlocksWithFinalText([
    { type: "text", id: "text_1", text: "Let me check the current state of the workspace to understand what's happening." },
    { type: "tool", id: "tool_1", name: "Read file", preview: "", status: "completed", duration: null, error: false },
    { type: "text", id: "text_2", text: "看起来工作区有一些 Mia 首页相关的文件（mia-homepage-v2.html）和一些设计素材。" },
    { type: "text", id: "text_final_3", text: "Let me check the current state of the workspace to understand what's happening.看起来工作区有一些 Mia 首页相关的文件（mia-homepage-v2.html）和一些设计素材。" }
  ], "Let me check the current state of the workspace to understand what's happening.看起来工作区有一些 Mia 首页相关的文件（mia-homepage-v2.html）和一些设计素材。"), [
    { type: "text", id: "text_1", text: "Let me check the current state of the workspace to understand what's happening." },
    { type: "tool", id: "tool_1", name: "Read file", preview: "", status: "completed", duration: null, error: false },
    { type: "text", id: "text_2", text: "看起来工作区有一些 Mia 首页相关的文件（mia-homepage-v2.html）和一些设计素材。" }
  ]);
});

test("final text completion rewrites a whitespace-reflowed legacy text_final block down to only the new suffix", () => {
  assert.deepEqual(contentBlocksWithFinalText([
    { type: "text", id: "text_1", text: "我先检查。" },
    { type: "tool", id: "tool_1", name: "shell", preview: "pwd", status: "completed", duration: null, error: false },
    { type: "text", id: "text_2", text: "看起来工作区有一些文件。" },
    { type: "text", id: "text_final_3", text: "我先检查。看起来工作区有一些文件。\n\n需要我帮你做什么？" }
  ], "我先检查。看起来工作区有一些文件。\n\n需要我帮你做什么？"), [
    { type: "text", id: "text_1", text: "我先检查。" },
    { type: "tool", id: "tool_1", name: "shell", preview: "pwd", status: "completed", duration: null, error: false },
    { type: "text", id: "text_2", text: "看起来工作区有一些文件。" },
    { type: "text", id: "text_final_3", text: "需要我帮你做什么？" }
  ]);
});

test("display text is distributed across ordered text blocks without hiding tools", () => {
  assert.deepEqual(contentBlocksWithDisplayText([
    { type: "text", id: "text_1", text: "我先整理。" },
    { type: "tool", id: "tool_1", name: "shell", preview: "ls", status: "completed", duration: null, error: false },
    { type: "text", id: "text_2", text: "然后给你结论。" }
  ], "我先整理。ls然后"), [
    { type: "text", id: "text_1", text: "我先整理。" },
    { type: "tool", id: "tool_1", name: "shell", preview: "ls", status: "completed", duration: null, error: false },
    { type: "text", id: "text_2", text: "然后" }
  ]);
});

test("display text is distributed across trace block internals", () => {
  const blocks = [
    { type: "text", id: "text_1", text: "先看。" },
    { type: "thinking", id: "thinking_1", text: "分析原因", status: "running", duration: null },
    { type: "tool", id: "tool_1", name: "shell", preview: "npm test", status: "running", duration: null, error: false },
    { type: "file_edit", id: "edit_1", path: "src/app.js", action: "update", diff: "-old\n+new", status: "completed", error: false }
  ];

  assert.equal(displayTextFromContentBlocks(blocks), "先看。分析原因npm test-old\n+new");
  assert.deepEqual(contentBlocksWithDisplayText(blocks, "先看。分析原因npm"), [
    { type: "text", id: "text_1", text: "先看。" },
    { type: "thinking", id: "thinking_1", text: "分析原因", status: "running", duration: null },
    { type: "tool", id: "tool_1", name: "shell", preview: "npm", status: "running", duration: null, error: false },
    { type: "file_edit", id: "edit_1", path: "src/app.js", action: "update", title: "Edited src/app.js", diff: "", additions: 0, deletions: 0, status: "completed", error: false }
  ]);
});

test("streaming text smoother keeps canonical text and reveals display text gradually", () => {
  const scheduled = [];
  const updates = [];
  const smoother = createStreamingTextSmoother({
    charsPerFrame: 2,
    schedule: (fn) => {
      scheduled.push(fn);
      return scheduled.length;
    },
    cancel: () => {},
    onUpdate: (run) => updates.push(run.displayText)
  });
  const run = { conversationId: "botc_u_a_mia", text: "" };

  run.text += "abcdef";
  smoother.enqueue(run, "abcdef");
  assert.equal(run.text, "abcdef");
  assert.equal(run.displayText, "");

  scheduled.shift()();
  assert.equal(run.displayText, "ab");
  scheduled.shift()();
  assert.equal(run.displayText, "abcd");

  smoother.flush(run);
  assert.equal(run.displayText, "abcdef");
  assert.deepEqual(updates, ["ab", "abcd", "abcdef"]);
});
