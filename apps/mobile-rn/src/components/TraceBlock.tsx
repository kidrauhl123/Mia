import { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { theme } from "../theme";

interface Props {
  trace: { reasoning?: any; tools?: any } | null | undefined;
}

function toText(v: any): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export default function TraceBlock({ trace }: Props) {
  const [open, setOpen] = useState(false);
  if (!trace || (!trace.reasoning && !trace.tools)) return null;
  const tools = Array.isArray(trace.tools) ? trace.tools : trace.tools ? [trace.tools] : [];
  const steps = (trace.reasoning ? 1 : 0) + tools.length;
  return (
    <View style={styles.wrap}>
      <Pressable onPress={() => setOpen((o) => !o)} hitSlop={6}>
        <Text style={styles.chip}>{open ? "▾ 思考" : `▸ 思考 · ${steps} 步`}</Text>
      </Pressable>
      {open ? (
        <View style={styles.body}>
          {trace.reasoning ? <Text style={styles.reason}>{toText(trace.reasoning)}</Text> : null}
          {tools.map((t: any, i: number) => (
            <Text key={i} style={styles.tool}>
              🔧 {toText(t.name || t.tool || t)}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 6 },
  chip: {
    alignSelf: "flex-start",
    backgroundColor: "#eeeeee",
    color: "#555",
    fontSize: 12,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: "hidden",
  },
  body: { marginTop: 6, paddingLeft: 4 },
  reason: { color: "#555", fontSize: 13, marginBottom: 4 },
  tool: { color: "#777", fontSize: 12 },
});
