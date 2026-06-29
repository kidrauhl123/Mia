const { test } = require("node:test");
const assert = require("node:assert/strict");

const helper = require("../src/renderer/bot/assistant-template.js");

const template = {
  name: "课程助教",
  responsibility: "长期管理一门课的资料、作业、复习和答疑。",
  line: "fallback line",
  setupPrompt: "第一次需要课程名、课程资料和考试/作业节点。",
  setup: {
    fields: [
      { id: "courseName", label: "课程名", type: "text", required: true, placeholder: "例如：计算机网络" },
      { id: "materials", label: "课程资料", type: "text", required: false, placeholder: "文件夹路径" },
      { id: "notes", label: "补充说明", type: "textarea", required: false, placeholder: "任意说明" }
    ]
  },
  handoffExamples: ["把本周课件整理成复习提纲。", "按考试时间倒排复习计划。"],
  persona: "你是「课程助教」，负责长期管理用户指定的一门课程。"
};

test("assistant template helper exposes responsibility and setup requirement", () => {
  assert.equal(helper.assistantResponsibility(template), "长期管理一门课的资料、作业、复习和答疑。");
  assert.equal(helper.assistantSetupRequirement(template), "第一次需要课程名、课程资料和考试/作业节点。");
  assert.deepEqual(helper.assistantHandoffExamples(template), ["把本周课件整理成复习提纲。", "按考试时间倒排复习计划。"]);
});

test("assistant setup summary records filled and missing required fields", () => {
  const summary = helper.assistantSetupSummary(template, { materials: "/tmp/course" });
  assert.deepEqual(summary.lines, ["课程资料：/tmp/course"]);
  assert.deepEqual(summary.missingRequired, ["课程名"]);
});

test("assistant persona text keeps long-lived responsibility and missing setup prompt", () => {
  const text = helper.assistantPersonaText(template, { materials: "/tmp/course" });
  assert.match(text, /你是「课程助教」/);
  assert.match(text, /## Mia Assistant Template Context/);
  assert.match(text, /长期负责：长期管理一门课的资料、作业、复习和答疑。/);
  assert.match(text, /已知设置：/);
  assert.match(text, /- 课程资料：\/tmp\/course/);
  assert.match(text, /缺失设置：课程名/);
  assert.match(text, /第一次对话请先补齐缺失设置/);
});

test("assistant description summarizes setup without replacing the role", () => {
  assert.equal(
    helper.assistantDescription(template, { courseName: "计算机网络" }),
    "长期管理一门课的资料、作业、复习和答疑。\n\n已设置：课程名：计算机网络"
  );
});
