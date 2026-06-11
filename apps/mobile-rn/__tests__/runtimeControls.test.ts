import {
  botIdForRuntimeControls,
  modelEntriesFromCatalog,
  patchForRuntimeField,
  runtimeControlState,
  runtimeKindForControls,
} from "../src/logic/runtimeControls";

test("detects bot id and runtime kind from bot conversation", () => {
  const conversation = { id: "botc_u_mia", type: "bot", bot_id: "mia", decorations: { runtimeKind: "cloud-hermes" } } as any;
  expect(botIdForRuntimeControls(conversation)).toBe("mia");
  expect(runtimeKindForControls(conversation)).toBe("cloud-hermes");
});

test("modelEntriesFromCatalog maps Cloud model catalog rows", () => {
  const entries = modelEntriesFromCatalog([
    { value: "mia-default", label: "Mia Default", model: "mia-default" },
    { modelName: "mia-pro", label: "Mia Pro", upstreamModel: "openai/gpt" },
  ] as any);
  expect(entries).toEqual([
    { id: "mia-default", value: "mia-default", model: "mia-default", label: "Mia Default" },
    { id: "mia-pro", value: "mia-pro", model: "openai/gpt", label: "Mia Pro" },
  ]);
});

test("patchForRuntimeField preserves desktop runtime semantics", () => {
  const entries = [{ value: "mia-default", model: "gpt-5.3", label: "GPT" }];
  expect(patchForRuntimeField("model", "mia-default", entries)).toEqual({ model: "gpt-5.3" });
  expect(patchForRuntimeField("effort", "high", entries)).toEqual({ effortLevel: "high" });
  expect(patchForRuntimeField("permission", "deny", entries)).toEqual({ permissionMode: "deny" });
});

test("runtimeControlState supplies selected values and defaults", () => {
  const state = runtimeControlState({
    binding: { config: { model: "gpt-5.3", effortLevel: "high", permissionMode: "deny" } } as any,
    modelEntries: [{ value: "mia-default", model: "gpt-5.3", label: "GPT" }],
  });
  expect(state.modelValue).toBe("mia-default");
  expect(state.effortValue).toBe("high");
  expect(state.permissionValue).toBe("deny");
});
