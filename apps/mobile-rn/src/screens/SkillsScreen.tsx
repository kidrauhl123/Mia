import { View } from "react-native";
import { Brand, Sub } from "../ui/Text";
import { color, space } from "../theme";

export default function SkillsScreen() {
  return (
    <View style={{ flex: 1, backgroundColor: color.bg, padding: space.lg, gap: space.sm }}>
      <Brand>Skills</Brand>
      <Sub>技能库、技能详情和启用到 Bot 的入口会在这里。</Sub>
    </View>
  );
}
