import { View, Text, StyleSheet } from "react-native";
import { theme } from "../theme";

export default function Avatar({ title, size = 42 }: { title: string; size?: number }) {
  const letter = (String(title || "?").trim()[0] || "?").toUpperCase();
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={styles.letter}>{letter}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { backgroundColor: theme.accent, alignItems: "center", justifyContent: "center" },
  letter: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
