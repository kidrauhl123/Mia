import { StyleSheet, View } from "react-native";
import { Body, Label } from "./Text";
import { useTypography } from "./TypographyProvider";
import { color, space } from "../theme";

export default function StateBlock({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}) {
  const typography = useTypography();
  return (
    <View style={styles.wrap}>
      <Label style={[styles.title, typography.type.settingHeader]}>{title}</Label>
      {detail ? <Body style={[styles.detail, typography.type.info]}>{detail}</Body> : null}
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
