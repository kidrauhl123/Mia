import { StyleSheet, View } from "react-native";
import { Body, Label } from "./Text";
import { color, space } from "../theme";

export default function StateBlock({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}) {
  return (
    <View style={styles.wrap}>
      <Label style={styles.title}>{title}</Label>
      {detail ? <Body style={styles.detail}>{detail}</Body> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
    gap: space.sm,
  },
  title: {
    color: color.inkMuted,
    textAlign: "center",
  },
  detail: {
    color: color.inkFaint,
    textAlign: "center",
  },
});
