import { createMobileCloudRunProjector } from "../src/logic/mobileCloudRun";

test("projects streaming run events into desktop-ordered assistant blocks", () => {
  const projector = createMobileCloudRunProjector();
  let run = projector.start({ conversationId: "c1", runId: "r1", botId: "bot_mia" });
  expect(run?.status).toBe("running");
  expect(run?.hasActivity).toBe(false);

  run = projector.apply({ conversationId: "c1", runId: "r1", event: { type: "reasoning.available", id: "think", reasoning: "检查上下文" } }, run);
  expect(run?.hasActivity).toBe(true);
  run = projector.apply({ conversationId: "c1", runId: "r1", event: { type: "message.delta", id: "text1", delta: "我先查。" } }, run);
  run = projector.apply({ conversationId: "c1", runId: "r1", event: { type: "tool.started", id: "tool1", tool: "search", input: "mia" } }, run);
  run = projector.apply({ conversationId: "c1", runId: "r1", event: { type: "tool.completed", id: "tool1", tool: "search", output: "ok", status: "completed" } }, run);
  run = projector.apply({ conversationId: "c1", runId: "r1", event: { type: "file_edit", id: "edit1", path: "README.md", diff: "+done", status: "completed" } }, run);
  run = projector.apply({ conversationId: "c1", runId: "r1", event: { type: "message.delta", id: "text2", delta: "完成。" } }, run);

  expect(run?.contentBlocks.map((block) => block.type)).toEqual([
    "thinking",
    "text",
    "tool",
    "file_edit",
    "text",
  ]);
  expect(run?.contentBlocks[2]).toMatchObject({ name: "search", preview: "ok", status: "completed" });
  expect(run?.contentBlocks[3]).toMatchObject({ path: "README.md", diff: "+done" });
});

test("run.completed supplies final text when an engine emitted no deltas", () => {
  const projector = createMobileCloudRunProjector();
  const run = projector.apply({
    conversation_id: "c1",
    run_id: "r2",
    bot_id: "bot_mia",
    event: { type: "run.completed", final_response: "最终答案" },
  });
  expect(run?.status).toBe("complete");
  expect(run?.contentBlocks).toEqual([{ type: "text", id: "text_0", text: "最终答案" }]);
});

test("run.completed appends only the missing suffix after streamed text", () => {
  const projector = createMobileCloudRunProjector();
  let run = projector.apply({
    conversationId: "c1",
    runId: "r3",
    event: { type: "message.delta", id: "text", delta: "最终" },
  });
  run = projector.apply({
    conversationId: "c1",
    runId: "r3",
    event: { type: "run.completed", final_response: "最终答案" },
  }, run);
  expect(run?.contentBlocks).toEqual([
    { type: "text", id: "text", text: "最终" },
    { type: "text", id: "text_final_1", text: "答案" },
  ]);
});
