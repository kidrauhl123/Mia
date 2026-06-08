import { chatKeyboardAvoidingBehavior, chatKeyboardAvoidingEnabled } from "../src/logic/keyboardAvoidance";

describe("chatKeyboardAvoidingBehavior", () => {
  it("keeps iOS on padding behavior", () => {
    expect(chatKeyboardAvoidingBehavior("ios")).toBe("padding");
    expect(chatKeyboardAvoidingEnabled("ios")).toBe(true);
  });

  it("does not add a second Android layout adjustment when native pan is enabled", () => {
    expect(chatKeyboardAvoidingBehavior("android")).toBeUndefined();
    expect(chatKeyboardAvoidingEnabled("android")).toBe(false);
  });
});
