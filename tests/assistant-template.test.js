const { test } = require("node:test");
const assert = require("node:assert/strict");

const helper = require("../src/renderer/bot/assistant-template.js");

const template = {
  name: "课程助教",
  responsibility: "整理一门课的资料、作业、复习和答疑。",
  line: "fallback line",
  contextBindings: ["课程名", "课程资料", "考试/作业节点"],
  handoffExamples: ["把本周课件整理成复习提纲。", "按考试时间倒排复习计划。"],
  persona: "你是「课程助教」，负责整理用户指定课程的资料、作业、复习和答疑。用户没有给出课程名或资料范围时，用一句自然问题补齐关键上下文，不要求用户填写表格。"
};

test("assistant template helper exposes responsibility and handoff examples without setup APIs", () => {
  assert.equal(helper.assistantResponsibility(template), "整理一门课的资料、作业、复习和答疑。");
  assert.deepEqual(helper.assistantHandoffExamples(template), ["把本周课件整理成复习提纲。", "按考试时间倒排复习计划。"]);
  assert.equal(helper.assistantSetupRequirement, undefined);
  assert.equal(helper.assistantSetupFields, undefined);
  assert.equal(helper.assistantSetupSummary, undefined);
});

test("assistant persona text keeps role, responsibility, context hints, and natural guidance", () => {
  const text = helper.assistantPersonaText(template);
  assert.match(text, /你是「课程助教」/);
  assert.match(text, /## Mia Assistant Template Context/);
  assert.match(text, /职责：整理一门课的资料、作业、复习和答疑。/);
  assert.match(text, /关注线索：课程名、课程资料、考试\/作业节点/);
  assert.match(text, /常见请求：/);
  assert.match(text, /- 把本周课件整理成复习提纲。/);
  assert.match(text, /不要求用户填写表格/);
  assert.doesNotMatch(text, /长期负责/);
  assert.doesNotMatch(text, /长期关注上下文/);
  assert.doesNotMatch(text, /缺失设置/);
  assert.doesNotMatch(text, /第一次对话请先补齐/);
});

test("assistant description stays focused on responsibility without setup summary", () => {
  assert.equal(
    helper.assistantDescription(template),
    "整理一门课的资料、作业、复习和答疑。"
  );
});
