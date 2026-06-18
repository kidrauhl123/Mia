const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  contentBlocksWithFinalText,
  createAssistantContentBlockCollector,
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
