import { messagePostBody, retryPayloadFromMessage } from "../src/logic/messageSend";
import type { ChatMessage } from "../src/api/types";

test("retry preserves turn/op ids, mentions, and attachments", () => {
  const message: ChatMessage = {
    messageId: "pending:c_1",
    clientTraceId: "c_1",
    clientOpId: "op_c_1",
    role: "user",
    senderKind: "user",
    senderRef: "u1",
    bodyMd: "@Mia助手 看附件",
    mentions: [{ kind: "bot", ref: "bot_mia" }],
    attachments: [{ id: "f1", type: "file", name: "a.txt", dataUrl: "data:text/plain;base64,QQ==" }],
    isOwn: true,
    isPending: false,
    failed: true,
    createdAt: "",
  };

  const retry = retryPayloadFromMessage(message);
  expect(messagePostBody(retry)).toEqual({
    bodyMd: "@Mia助手 看附件",
    turnId: "c_1",
    clientOpId: "op_c_1",
    mentions: [{ kind: "bot", ref: "bot_mia" }],
    attachments: [{ id: "f1", type: "file", name: "a.txt", dataUrl: "data:text/plain;base64,QQ==" }],
  });
});

test("retry derives the same deterministic op id for legacy pending rows", () => {
  const message = {
    messageId: "pending:c_old",
    clientTraceId: "c_old",
    role: "user",
    bodyMd: "again",
    isOwn: true,
    isPending: false,
    createdAt: "",
  } as ChatMessage;
  expect(messagePostBody(retryPayloadFromMessage(message)).clientOpId).toBe("op_c_old");
});
