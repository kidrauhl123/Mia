import { View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Brand, Sub } from "../ui/Text";
import { color, space } from "../theme";
import type { MessagesStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<MessagesStackParamList, "GroupDetail">;

export default function GroupDetailScreen({ route }: Props) {
  return (
    <View style={{ flex: 1, backgroundColor: color.bg, padding: space.lg, gap: space.sm }}>
      <Brand>{route.params.title}</Brand>
      <Sub>{route.params.conversationId}</Sub>
    </View>
  );
}
