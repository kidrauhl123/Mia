import { createNativeStackNavigator } from "@react-navigation/native-stack";
import ConversationListScreen from "../screens/ConversationListScreen";
import ChatScreen from "../screens/ChatScreen";
import GroupDetailScreen from "../screens/GroupDetailScreen";
import BotSessionsScreen from "../screens/BotSessionsScreen";
import { color } from "../theme";
import { conversationHomeChrome } from "../logic/conversationHomeChrome";
import type { MessagesStackParamList } from "./types";

const MessagesStackNav = createNativeStackNavigator<MessagesStackParamList>();

const headerOptions = {
  headerStyle: { backgroundColor: color.bg },
  headerShadowVisible: false,
  headerTintColor: color.accent,
  headerTitleStyle: { fontSize: 17, fontWeight: "700" as const, color: color.ink },
  headerTitleAlign: "center" as const,
  contentStyle: { backgroundColor: color.bg },
};

function MessagesStack() {
  return (
    <MessagesStackNav.Navigator screenOptions={headerOptions}>
      <MessagesStackNav.Screen
        name="Conversations"
        component={ConversationListScreen}
        options={{ title: "消息", headerShown: conversationHomeChrome.nativeHeaderShown }}
      />
      <MessagesStackNav.Screen
        name="Chat"
        component={ChatScreen}
        options={({ route }) => ({ title: route.params?.title || "" })}
      />
      <MessagesStackNav.Screen
        name="GroupDetail"
        component={GroupDetailScreen}
        options={({ route }) => ({ title: route.params?.title || "群聊" })}
      />
      <MessagesStackNav.Screen
        name="BotSessions"
        component={BotSessionsScreen}
        options={{ title: "聊天记录" }}
      />
    </MessagesStackNav.Navigator>
  );
}

export default function Tabs() {
  return <MessagesStack />;
}
