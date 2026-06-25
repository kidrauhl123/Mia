import { Pressable, Text, StyleSheet, ActivityIndicator, ViewStyle } from "react-native";
import { color, radius, space } from "../theme";
import { withAndroidTextFace } from "./androidTextFace";
import { useTypography } from "./TypographyProvider";

type Variant = "primary" | "outline" | "ghost" | "danger";

interface Props {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  disabled?: boolean;
  busy?: boolean;
  style?: ViewStyle;
}

// 按钮对齐桌面 .primary-action:靛蓝实底、圆角 12、粗体(非大写)。
export default function Button({ label, onPress, variant = "primary", disabled, busy, style }: Props) {
  const onAccent = variant === "primary";
  const typography = useTypography();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.base,
        variant === "primary" && styles.primary,
        variant === "outline" && styles.outline,
        variant === "ghost" && styles.ghost,
        variant === "danger" && styles.danger,
        (disabled || busy) && styles.disabled,
        pressed && styles.pressed,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={onAccent ? color.accentText : color.accent} />
      ) : (
        <Text
          allowFontScaling={false}
          style={withAndroidTextFace([typography.type.button, onAccent ? styles.labelOnAccent : variant === "danger" ? styles.labelDanger : styles.labelInk], label)}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { height: 46, borderRadius: radius.md, alignItems: "center", justifyContent: "center", paddingHorizontal: space.lg },
  primary: { backgroundColor: color.accent },
  outline: { backgroundColor: color.surface, borderWidth: 1, borderColor: color.line },
  ghost: { backgroundColor: "transparent" },
  danger: { backgroundColor: color.surfaceMuted },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.88 },
  labelOnAccent: { color: color.accentText },
  labelInk: { color: color.ink },
  labelDanger: { color: color.danger },
});
