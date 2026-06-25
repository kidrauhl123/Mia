import { TextInput, TextInputProps, StyleSheet } from "react-native";
import { color, radius, space } from "../theme";
import { withAndroidTextFace } from "./androidTextFace";
import { useTypography } from "./TypographyProvider";

// 输入框对齐桌面:白底、1px 淡边线、圆角 12。
export default function Input(props: TextInputProps) {
  const typography = useTypography();
  return (
    <TextInput
      {...props}
      allowFontScaling={props.allowFontScaling ?? false}
      placeholderTextColor={color.inkFaint}
      style={withAndroidTextFace([styles.input, typography.type.input, props.style])}
    />
  );
}

const styles = StyleSheet.create({
  input: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    color: color.ink,
  },
});
