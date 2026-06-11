import type { BotRuntimeBinding, Conversation, PlatformModelRow, RuntimeModelEntry } from "../api/types";

type ModelEntryLike = Partial<RuntimeModelEntry> & {
  value?: string;
  model?: string;
  label?: string;
};

export const EFFORT_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export const PERMISSION_OPTIONS = [
  { value: "ask", label: "Ask" },
  { value: "yolo", label: "YOLO" },
  { value: "deny", label: "Deny" },
];

export function botIdForRuntimeControls(conversation?: Conversation | null): string {
  return String(conversation?.decorations?.botId || conversation?.bot_id || conversation?.botId || "").trim();
}

export function runtimeKindForControls(conversation?: Conversation | null): string {
  return String(conversation?.decorations?.runtimeKind || "cloud-hermes").trim() || "cloud-hermes";
}

export function modelEntriesFromCatalog(rows: PlatformModelRow[] = []): RuntimeModelEntry[] {
  const entries = rows.map((row) => {
    const value = String(row.value || row.id || row.modelName || row.model || "").trim();
    const model = String(row.model || row.upstreamModel || value).trim();
    const label = String(row.label || row.name || value || model).trim();
    if (!value && !model) return null;
    return {
      id: value || model,
      value: value || model,
      model: model || value,
      label: label || value || model,
      ...(row.provider ? { provider: String(row.provider) } : {}),
      ...(row.providerLabel ? { providerLabel: String(row.providerLabel) } : {}),
    };
  }).filter(Boolean) as RuntimeModelEntry[];
  return entries.length ? entries : [{ id: "mia-default", value: "mia-default", model: "mia-default", label: "Mia Default" }];
}

function modelEntryForValue(entries: ModelEntryLike[], value: string): ModelEntryLike | null {
  const wanted = String(value || "").trim();
  return entries.find((entry) => [entry.id, entry.value, entry.model].some((item) => String(item || "").trim() === wanted)) || null;
}

export function patchForRuntimeField(field: string, value: string, modelEntries: ModelEntryLike[] = []): Record<string, string> {
  if (field === "model") {
    const entry = modelEntryForValue(modelEntries, value);
    return { model: entry?.model || value };
  }
  if (field === "effort" || field === "effortLevel") return { effortLevel: value };
  if (field === "permission" || field === "permissionMode") return { permissionMode: value };
  return {};
}

export function runtimeControlState({
  binding,
  modelEntries,
}: {
  binding?: BotRuntimeBinding | null;
  modelEntries: ModelEntryLike[];
}) {
  const config = binding?.config || {};
  const currentModel = String(config.model || modelEntries[0]?.model || modelEntries[0]?.value || "mia-default");
  const modelEntry = modelEntryForValue(modelEntries, currentModel) || modelEntries[0];
  return {
    modelValue: modelEntry?.value || currentModel,
    effortValue: String(config.effortLevel || "medium"),
    permissionValue: String(config.permissionMode || "ask"),
  };
}
