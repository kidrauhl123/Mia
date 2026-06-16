import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { NavigationState, PartialState, Route } from "@react-navigation/native";
import ConversationListScreen from "../screens/ConversationListScreen";
import ChatScreen from "../screens/ChatScreen";
import ContactsScreen from "../screens/ContactsScreen";
import AgentsScreen from "../screens/AgentsScreen";
import SkillsScreen from "../screens/SkillsScreen";
import SettingsScreen from "../screens/SettingsScreen";
import BotDetailScreen from "../screens/BotDetailScreen";
import GroupDetailScreen from "../screens/GroupDetailScreen";
import BotSessionsScreen from "../screens/BotSessionsScreen";
import AnimatedTabBar from "./AnimatedTabBar";
import { color } from "../theme";
import type {
  AgentsStackParamList,
  ContactsStackParamList,
  MessagesStackParamList,
  SettingsStackParamList,
  SkillsStackParamList,
} from "./types";

const MessagesStackNav = createNativeStackNavigator<MessagesStackParamList>();
const ContactsStackNav = createNativeStackNavigator<ContactsStackParamList>();
const AgentsStackNav = createNativeStackNavigator<AgentsStackParamList>();
const SkillsStackNav = createNativeStackNavigator<SkillsStackParamList>();
const SettingsStackNav = createNativeStackNavigator<SettingsStackParamList>();
const Tab = createBottomTabNavigator();
const HIDE_TAB_ON_CHILD = new Set(["Chat", "GroupDetail", "BotSessions", "BotDetail"]);

const headerOptions = {
  headerStyle: { backgroundColor: color.bg },
  headerShadowVisible: false,
  headerTintColor: color.accent,
  headerTitleStyle: { fontSize: 17, fontWeight: "700" as const, color: color.ink },
  headerTitleAlign: "center" as const,
  contentStyle: { backgroundColor: color.bg },
};

function activeChildName(route: Route<string> & { state?: NavigationState | PartialState<NavigationState> }) {
  const state = route.state;
  if (!state || !Array.isArray(state.routes) || !state.routes.length) return "";
  const index = typeof state.index === "number" ? state.index : 0;
  return state.routes[index]?.name || "";
}

function shouldHideTabBar(state: NavigationState) {
  const route = state.routes[state.index] as Route<string> & { state?: NavigationState | PartialState<NavigationState> };
  return HIDE_TAB_ON_CHILD.has(activeChildName(route));
}

function MessagesStack() {
  return (
    <MessagesStackNav.Navigator screenOptions={headerOptions}>
      <MessagesStackNav.Screen name="Conversations" component={ConversationListScreen} options={{ title: "消息" }} />
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

function ContactsStack() {
  return (
    <ContactsStackNav.Navigator screenOptions={headerOptions}>
      <ContactsStackNav.Screen name="ContactsHome" component={ContactsScreen} options={{ title: "联系人" }} />
      <ContactsStackNav.Screen
        name="BotDetail"
        component={BotDetailScreen}
        options={({ route }) => ({ title: route.params?.title || "Bot" })}
      />
    </ContactsStackNav.Navigator>
  );
}

function AgentsStack() {
  return (
    <AgentsStackNav.Navigator screenOptions={headerOptions}>
      <AgentsStackNav.Screen name="AgentsHome" component={AgentsScreen} options={{ title: "运行" }} />
    </AgentsStackNav.Navigator>
  );
}

function SkillsStack() {
  return (
    <SkillsStackNav.Navigator screenOptions={headerOptions}>
      <SkillsStackNav.Screen name="SkillsHome" component={SkillsScreen} options={{ title: "技能" }} />
    </SkillsStackNav.Navigator>
  );
}

function SettingsStack() {
  return (
    <SettingsStackNav.Navigator screenOptions={headerOptions}>
      <SettingsStackNav.Screen name="SettingsHome" component={SettingsScreen} options={{ title: "设置" }} />
    </SettingsStackNav.Navigator>
  );
}

export default function Tabs() {
  return (
    <Tab.Navigator screenOptions={headerOptions} tabBar={(props) => shouldHideTabBar(props.state) ? null : <AnimatedTabBar {...props} />}>
      <Tab.Screen name="Messages" component={MessagesStack} options={{ headerShown: false, title: "消息" }} />
      <Tab.Screen name="Contacts" component={ContactsStack} options={{ headerShown: false, title: "联系人" }} />
      <Tab.Screen name="Agents" component={AgentsStack} options={{ headerShown: false, title: "运行" }} />
      <Tab.Screen name="Skills" component={SkillsStack} options={{ headerShown: false, title: "技能" }} />
      <Tab.Screen name="Settings" component={SettingsStack} options={{ headerShown: false, title: "设置" }} />
    </Tab.Navigator>
  );
}
