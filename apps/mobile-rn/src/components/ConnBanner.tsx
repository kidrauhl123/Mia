import { View, Text, StyleSheet } from "react-native";
import { theme } from "../theme";
import { useEvents } from "../state/events";

export default function ConnBanner() {
  const { connStatus } = useEvents();
  if (connStatus === "open") return null;
  return (
    <View style={styles.bar}>
      <Text style={styles.text}>连接中…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { backgroundColor: theme.warnBg, paddingVertical: 5 },
  text: { color: theme.warn, textAlign: "center", fontSize: 13 },
});
