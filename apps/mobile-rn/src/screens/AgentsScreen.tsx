import { View } from "react-native";
import { Brand, Sub } from "../ui/Text";
import { color, space } from "../theme";

export default function AgentsScreen() {
  return (
    <View style={{ flex: 1, backgroundColor: color.bg, padding: space.lg, gap: space.sm }}>
      <Brand>Agents</Brand>
      <Sub>桌面 Bridge、运行中任务、权限等待和运行历史会在这里汇总。</Sub>
    </View>
  );
}
