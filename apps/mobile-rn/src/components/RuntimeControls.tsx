import { ScrollView, Pressable, StyleSheet, View } from "react-native";
import { EFFORT_OPTIONS, PERMISSION_OPTIONS } from "../logic/runtimeControls";
import { BodyStrong, Label } from "../ui/Text";
import { color, radius, space, hairlineWidth } from "../theme";
import type { RuntimeModelEntry } from "../api/types";

type RuntimeField = "model" | "effort" | "permission";

function ControlRow({
  label,
  options,
  value,
  saving,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  saving?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <View style={styles.row}>
      <Label style={styles.rowLabel}>{label}</Label>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.options}>
        {options.map((option) => {
          const active = option.value === value;
          return (
            <Pressable
              key={option.value}
              disabled={saving || active}
              style={[styles.option, active ? styles.optionActive : null, saving ? styles.optionSaving : null]}
              onPress={() => onChange(option.value)}
            >
              <Label style={active ? styles.optionTextActive : styles.optionText}>{option.label}</Label>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

export default function RuntimeControls({
  modelEntries,
  modelValue,
  effortValue,
  permissionValue,
  savingField,
  error,
  onChange,
}: {
  modelEntries: RuntimeModelEntry[];
  modelValue: string;
  effortValue: string;
  permissionValue: string;
  savingField?: RuntimeField | "";
  error?: string;
  onChange: (field: RuntimeField, value: string) => void;
}) {
  const modelOptions = modelEntries.map((entry) => ({ value: entry.value, label: entry.label }));
  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <BodyStrong>运行设置</BodyStrong>
        <Label>{savingField ? "保存中…" : "云端运行"}</Label>
      </View>
      <ControlRow label="模型" options={modelOptions} value={modelValue} saving={savingField === "model"} onChange={(value) => onChange("model", value)} />
      <ControlRow label="强度" options={EFFORT_OPTIONS} value={effortValue} saving={savingField === "effort"} onChange={(value) => onChange("effort", value)} />
      <ControlRow label="权限" options={PERMISSION_OPTIONS} value={permissionValue} saving={savingField === "permission"} onChange={(value) => onChange("permission", value)} />
      {error ? <Label style={styles.error}>{error}</Label> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    backgroundColor: color.surface,
    borderTopWidth: hairlineWidth,
    borderTopColor: color.line,
  },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.md },
  row: { gap: space.xs },
  rowLabel: { color: color.inkFaint },
  options: { gap: space.xs, paddingRight: space.md },
  option: {
    minHeight: 30,
    borderRadius: radius.pill,
    borderWidth: hairlineWidth,
    borderColor: color.line,
    paddingHorizontal: space.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.surface,
  },
  optionActive: { borderColor: color.accent, backgroundColor: color.accentSoft },
  optionSaving: { opacity: 0.5 },
  optionText: { color: color.inkMuted },
  optionTextActive: { color: color.accent },
  error: { color: color.danger },
});
