import { resolveMessageAuthor } from "../src/logic/messageAuthor";
import type { ChatMessage, Member } from "../src/api/types";

test("resolveMessageAuthor reads bot identity name and status badge from members", () => {
  const badge = { kind: "lottie" as const, assetId: "rainbow", label: "Active" };
  const msg: ChatMessage = {
    messageId: "m1",
    clientTraceId: "",
    role: "assistant",
    senderKind: "bot",
    senderRef: "mia",
    bodyMd: "hi",
    isOwn: false,
    isPending: false,
    createdAt: "",
  };
  const members: Member[] = [{
    member_kind: "bot",
    member_ref: "mia",
    identity: { kind: "bot", id: "mia", displayName: "Mia", statusBadge: badge },
  }];

  expect(resolveMessageAuthor(msg, members)).toMatchObject({
    name: "Mia",
    statusBadge: badge,
  });
});
