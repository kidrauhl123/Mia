import { View, Text, FlatList, StyleSheet } from "react-native";
import { useFellows, useFriends } from "../state/queries";
import Avatar from "../components/Avatar";
import { theme } from "../theme";

interface Row {
  key: string;
  title: string;
  sub: string;
}

export default function ContactsScreen() {
  const { data: fellows = [] } = useFellows();
  const { data: friends = [] } = useFriends();
  const rows: Row[] = [
    ...friends.map((f, i) => ({ key: `fr:${f.id || i}`, title: f.username || String(f.id), sub: "好友" })),
    ...fellows.map((f, i) => ({ key: `fe:${f.id || f.key || i}`, title: f.name || String(f.id || f.key), sub: "Fellow" })),
  ];
  return (
    <FlatList
      style={styles.root}
      data={rows}
      keyExtractor={(r) => r.key}
      ListEmptyComponent={<Text style={styles.empty}>暂无联系人</Text>}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <Avatar title={item.title} />
          <View style={styles.col}>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.sub}>{item.sub}</Text>
          </View>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  empty: { textAlign: "center", color: theme.muted, marginTop: 40 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderBottomWidth: 1, borderBottomColor: theme.line, backgroundColor: theme.card },
  col: { flex: 1 },
  title: { fontWeight: "600", color: theme.text },
  sub: { color: theme.muted, fontSize: 13 },
});
