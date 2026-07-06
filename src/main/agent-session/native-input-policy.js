const HISTORY_KEYS = new Set([
  "messages",
  "history",
  "conversationHistory",
  "previousMessages",
  "transcript",
  "assistantHistory",
  "priorUserMessages",
  "priorAssistantMessages"
]);

const ALLOWED_KEYS = new Set([
  "turnId",
  "text",
  "attachments",
  "fileReferences",
  "workspacePath",
  "cwd",
  "sessionId",
  "initializationMetadata",
  "turnPromptPrefix",
  "skillFallback"
]);

function nativeInputPolicyError(reason) {
  const error = new Error(`Native input policy rejected prompt payload: ${reason}`);
  error.code = "NATIVE_INPUT_POLICY_REJECTED";
  return error;
}

function isTranscriptRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return role === "user" || role === "assistant" || role === "system" || role === "developer";
}

function isRoleArray(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => entry && typeof entry === "object" && isTranscriptRole(entry.role));
}

function cloneAllowedValue(value) {
  if (Array.isArray(value)) return value.slice();
  if (value && typeof value === "object") return { ...value };
  return value;
}

function prepareNativeTurnInput(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw nativeInputPolicyError("expected an object input");
  }

  for (const key of HISTORY_KEYS) {
    if (key in input) {
      throw nativeInputPolicyError(`history-bearing key "${key}" is not allowed`);
    }
  }

  for (const [key, value] of Object.entries(input)) {
    if (isRoleArray(value)) {
      throw nativeInputPolicyError(`role-array transcript replay is not allowed in "${key}"`);
    }
  }

  const prepared = {};
  for (const key of ALLOWED_KEYS) {
    if (key in input) {
      prepared[key] = cloneAllowedValue(input[key]);
    }
  }
  if (!("text" in prepared)) {
    prepared.text = "";
  }
  return prepared;
}

module.exports = Object.freeze({
  ALLOWED_KEYS,
  HISTORY_KEYS,
  nativeInputPolicyError,
  prepareNativeTurnInput
});
