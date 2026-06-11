type KeyboardAvoidingBehavior = "height" | "position" | "padding";

export function chatKeyboardAvoidingBehavior(platform: string): KeyboardAvoidingBehavior | undefined {
  return platform === "ios" ? "padding" : undefined;
}

export function chatKeyboardAvoidingEnabled(platform: string): boolean {
  return platform === "ios";
}
