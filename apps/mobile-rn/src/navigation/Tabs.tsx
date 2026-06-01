import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import ConversationListScreen from "../screens/ConversationListScreen";
import ChatScreen from "../screens/ChatScreen";
import ContactsScreen from "../screens/ContactsScreen";
import MeScreen from "../screens/MeScreen";
import type { MessagesStackParamList } from "./types";

const Stack = createNativeStackNavigator<MessagesStackParamList>();
const Tab = createBottomTabNavigator();

function MessagesStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="Conversations" component={ConversationListScreen} options={{ title: "消息" }} />
      <Stack.Screen
        name="Chat"
        component={ChatScreen}
        options={({ route }) => ({ title: route.params?.title || "" })}
      />
    </Stack.Navigator>
  );
}

export default function Tabs() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="Messages" component={MessagesStack} options={{ headerShown: false, title: "消息" }} />
      <Tab.Screen name="Contacts" component={ContactsScreen} options={{ title: "联系人" }} />
      <Tab.Screen name="Me" component={MeScreen} options={{ title: "我" }} />
    </Tab.Navigator>
  );
}
