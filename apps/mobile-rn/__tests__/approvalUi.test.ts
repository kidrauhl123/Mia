import { approvalDecisionErrorText, approvalQueueLabel } from "../src/logic/approvalUi";

test("approvalQueueLabel shows queue position when multiple approvals wait", () => {
  expect(approvalQueueLabel(0)).toBe("请求权限");
  expect(approvalQueueLabel(1)).toBe("请求权限");
  expect(approvalQueueLabel(3)).toBe("请求权限 · 1/3");
});

test("approvalDecisionErrorText preserves API error message with fallback", () => {
  expect(approvalDecisionErrorText(new Error("run expired"))).toBe("run expired");
  expect(approvalDecisionErrorText("")).toBe("提交失败");
});
