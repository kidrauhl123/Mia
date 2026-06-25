import { useCallback, useMemo, type ComponentType } from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { useFocusEffect } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { MessageCircle, UserRound, type LucideIcon } from "lucide-react-native";
import ConversationListScreen from "../screens/ConversationListScreen";
import ChatScreen from "../screens/ChatScreen";
import GroupDetailScreen from "../screens/GroupDetailScreen";
import BotSessionsScreen from "../screens/BotSessionsScreen";
import MeScreen from "../screens/MeScreen";
import { color } from "../theme";
import { useTypography } from "../ui/TypographyProvider";
import { conversationHomeChrome } from "../logic/conversationHomeChrome";
import type { MeStackParamList, MessagesStackParamList } from "./types";

const MessagesStackNav = createNativeStackNavigator<MessagesStackParamList>();
const MeStackNav = createNativeStackNavigator<MeStackParamList>();
const Tab = createBottomTabNavigator();

const TAB_ICON: Record<string, LucideIcon> = {
  Messages: MessageCircle,
  Me: UserRound,
};

const TAB_LABEL: Record<string, string> = {
  Messages: "消息",
  Me: "我的",
};

const tabBarBaseStyle = {
  height: 64,
  paddingTop: 6,
  paddingBottom: 8,
  borderTopColor: color.line,
  backgroundColor: color.bg,
};
const tabBarHiddenStyle = { display: "none" as const };

function withTabBarVisibility<P extends { navigation: { getParent?: () => { setOptions?: (options: unknown) => void } | undefined } }>(
  Component: ComponentType<P>,
  visible: boolean
) {
  return function TabBarVisibilityScreen(props: P) {
    useFocusEffect(
      useCallback(() => {
        const parent = props.navigation.getParent?.();
        parent?.setOptions?.({ tabBarStyle: visible ? tabBarBaseStyle : tabBarHiddenStyle });
        return visible ? undefined : () => parent?.setOptions?.({ tabBarStyle: tabBarBaseStyle });
      }, [props.navigation])
    );
    return <Component {...props} />;
  };
}

const ConversationListWithTabBar = withTabBarVisibility(ConversationListScreen, true);
const ChatWithoutTabBar = withTabBarVisibility(ChatScreen, false);
const GroupDetailWithoutTabBar = withTabBarVisibility(GroupDetailScreen, false);
const BotSessionsWithoutTabBar = withTabBarVisibility(BotSessionsScreen, false);

function useHeaderOptions() {
  const typography = useTypography();
  return useMemo(() => ({
    headerStyle: { backgroundColor: color.bg },
    headerShadowVisible: false,
    headerTintColor: color.accent,
    headerTitleStyle: typography.type.title,
    headerTitleAlign: "center" as const,
    contentStyle: { backgroundColor: color.bg },
  }), [typography.type.title]);
}

function MessagesStack() {
  const headerOptions = useHeaderOptions();
  return (
    <MessagesStackNav.Navigator screenOptions={headerOptions}>
      <MessagesStackNav.Screen
        name="Conversations"
        component={ConversationListWithTabBar}
        options={{ title: "消息", headerShown: conversationHomeChrome.nativeHeaderShown }}
      />
      <MessagesStackNav.Screen
        name="Chat"
        component={ChatWithoutTabBar}
        options={({ route }) => ({ title: route.params?.title || "" })}
      />
      <MessagesStackNav.Screen
        name="GroupDetail"
        component={GroupDetailWithoutTabBar}
        options={({ route }) => ({ title: route.params?.title || "群聊" })}
      />
      <MessagesStackNav.Screen
        name="BotSessions"
        component={BotSessionsWithoutTabBar}
        options={{ title: "聊天记录" }}
      />
    </MessagesStackNav.Navigator>
  );
}

function MeStack() {
  const headerOptions = useHeaderOptions();
  return (
    <MeStackNav.Navigator screenOptions={headerOptions}>
      <MeStackNav.Screen name="MeHome" component={MeScreen} options={{ title: "我的" }} />
    </MeStackNav.Navigator>
  );
}

export default function Tabs() {
  const typography = useTypography();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: tabBarBaseStyle,
        tabBarActiveTintColor: color.accent,
        tabBarInactiveTintColor: color.inkFaint,
        tabBarLabel: TAB_LABEL[route.name] || route.name,
        tabBarLabelStyle: typography.type.nav,
        tabBarIcon: ({ color: tint, focused }) => {
          const Icon = TAB_ICON[route.name] || MessageCircle;
          return <Icon color={tint} size={24} strokeWidth={focused ? 2.5 : 2} />;
        },
      })}
    >
      <Tab.Screen name="Messages" component={MessagesStack} />
      <Tab.Screen name="Me" component={MeStack} />
    </Tab.Navigator>
  );
}
