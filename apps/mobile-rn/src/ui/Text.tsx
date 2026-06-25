import { Text as RNText, TextProps } from "react-native";
import { withAndroidTextFace } from "./androidTextFace";
import { useTypography } from "./TypographyProvider";

export function Brand(p: TextProps) {
  const typography = useTypography();
  return <RNText {...p} allowFontScaling={p.allowFontScaling ?? false} style={withAndroidTextFace([typography.type.brand, p.style], p.children)} />;
}
export function Title(p: TextProps) {
  const typography = useTypography();
  return <RNText {...p} allowFontScaling={p.allowFontScaling ?? false} style={withAndroidTextFace([typography.type.title, p.style], p.children)} />;
}
export function Body(p: TextProps) {
  const typography = useTypography();
  return <RNText {...p} allowFontScaling={p.allowFontScaling ?? false} style={withAndroidTextFace([typography.type.body, p.style], p.children)} />;
}
export function BodyStrong(p: TextProps) {
  const typography = useTypography();
  return <RNText {...p} allowFontScaling={p.allowFontScaling ?? false} style={withAndroidTextFace([typography.type.bodyStrong, p.style], p.children)} />;
}
export function Sub(p: TextProps) {
  const typography = useTypography();
  return <RNText {...p} allowFontScaling={p.allowFontScaling ?? false} style={withAndroidTextFace([typography.type.sub, p.style], p.children)} />;
}
export function Label(p: TextProps) {
  const typography = useTypography();
  return <RNText {...p} allowFontScaling={p.allowFontScaling ?? false} style={withAndroidTextFace([typography.type.label, p.style], p.children)} />;
}
