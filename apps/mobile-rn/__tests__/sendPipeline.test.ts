import { prepareOutgoingMessage, parseMentions } from "../src/logic/sendPipeline";

test("正常消息:trim + clientTraceId", () => {
  const r = prepareOutgoingMessage({ text: "  hi  " }, {});
  expect(r.bodyMd).toBe("hi");
  expect(r.clientTraceId).toMatch(/^c_/);
  expect(r.mentions).toEqual([]);
});

test("空消息抛 EMPTY_MESSAGE", () => {
  expect(() => prepareOutgoingMessage({ text: "   " }, {})).toThrow(/empty/i);
});

test("超长抛 MESSAGE_TOO_LONG", () => {
  expect(() => prepareOutgoingMessage({ text: "x".repeat(11) }, { maxLength: 10 })).toThrow(/exceeds/);
});

test("parseMentions 匹配 bot 成员", () => {
  const members = [{ member_kind: "bot", member_ref: "claude" }];
  expect(parseMentions("hey @claude 看下", members)).toEqual([{ kind: "bot", ref: "claude" }]);
  expect(parseMentions("no mention", members)).toEqual([]);
});
