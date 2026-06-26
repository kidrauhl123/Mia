import {
  botIdentityBody,
  botKey,
  botRuntimeDefaultConfig,
  cloudBotKeyFromName,
  slugFromBotName,
} from "../src/logic/botDraft";

test("slugFromBotName mirrors desktop cloud bot key rules", () => {
  expect(slugFromBotName("Code Review")).toBe("code_review");
  expect(slugFromBotName("空铃")).toBe("bot");
  expect(slugFromBotName("  Mia!!!  ")).toBe("mia");
});

test("cloudBotKeyFromName avoids existing keys", () => {
  expect(cloudBotKeyFromName("Mia", ["mia", "mia_2"])).toBe("mia_3");
});

test("botKey reads canonical id aliases", () => {
  expect(botKey({ key: "k", id: "i" })).toBe("k");
  expect(botKey({ id: "i" })).toBe("i");
  expect(botKey({ bot_id: "b" })).toBe("b");
});

test("botIdentityBody preserves persona in cloud identity fields", () => {
  expect(botIdentityBody({ name: "  Mia  ", personaText: "  helpful  " })).toEqual({
    name: "Mia",
    color: "#2563eb",
    avatarImage: "",
    avatarCrop: null,
    bio: "helpful",
    personaText: "helpful",
    capabilities: { legacyCapabilities: ["chat", "files", "terminal", "code"] },
  });
});

test("botRuntimeDefaultConfig uses cloud hermes defaults", () => {
  expect(botRuntimeDefaultConfig()).toEqual({
    model: "mia-auto",
    effortLevel: "medium",
    permissionMode: "ask",
  });
});
