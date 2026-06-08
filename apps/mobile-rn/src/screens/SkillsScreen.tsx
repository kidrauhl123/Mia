import { FlatList, StyleSheet, View } from "react-native";
import { useSkills } from "../state/queries";
import StateBlock from "../ui/StateBlock";
import { BodyStrong, Label, Sub } from "../ui/Text";
import { color, space, hairlineWidth } from "../theme";

function titleFor(skill: { name?: string; title?: string; id: string }): string {
  return skill.title || skill.name || skill.id;
}

export default function SkillsScreen() {
  const { data, isLoading, error } = useSkills({ limit: 80 });
  const skills = data?.skills || [];

  if (isLoading) return <StateBlock title="加载技能库…" />;
  if (error) return <StateBlock title="技能库加载失败" detail={String((error as Error).message || error)} />;
  if (!skills.length) return <StateBlock title="暂无技能" detail="Cloud 技能库同步后会显示在这里。" />;

  return (
    <FlatList
      style={styles.root}
      data={skills}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={styles.mark}>
            <Label style={styles.markText}>{titleFor(item).slice(0, 2)}</Label>
          </View>
          <View style={styles.text}>
            <BodyStrong numberOfLines={1}>{titleFor(item)}</BodyStrong>
            <Sub numberOfLines={2}>{item.description || item.category || item.id}</Sub>
          </View>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  row: {
    flexDirection: "row",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.line,
  },
  mark: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.surfaceMuted,
  },
  markText: { color: color.accent },
  text: { flex: 1, minWidth: 0, gap: 3 },
});
