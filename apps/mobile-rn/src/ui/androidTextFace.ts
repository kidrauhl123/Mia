import { Platform, StyleProp, StyleSheet, TextStyle } from "react-native";

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

function mediumWeight(weight: TextStyle["fontWeight"]): boolean {
  if (typeof weight === "number") return weight >= 500;
  return weight === "bold" || weight === "500" || weight === "600" || weight === "700" || weight === "800" || weight === "900";
}

function regularWeight(weight: TextStyle["fontWeight"]): boolean {
  return !weight || weight === "normal" || weight === "400" || weight === 400;
}

function textFromChildren(children: unknown): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textFromChildren).join("");
  return "";
}

export function withAndroidTextFace(style: StyleProp<TextStyle>, children?: unknown): StyleProp<TextStyle> {
  if (Platform.OS !== "android") return style;
  const flattened = StyleSheet.flatten(style);
  if (!flattened || flattened.fontFamily) return style;
  if (mediumWeight(flattened.fontWeight)) {
    return CJK_RE.test(textFromChildren(children)) ? [style, styles.cjkMedium] : [styles.medium, style];
  }
  return regularWeight(flattened.fontWeight) ? [styles.regular, style] : style;
}

const styles = StyleSheet.create({
  regular: { fontFamily: "sans-serif" },
  medium: { fontFamily: "sans-serif-medium" },
  cjkMedium: { fontFamily: "sans-serif", fontWeight: "700" },
});
