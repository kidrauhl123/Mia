import { NavigationContainer } from "@react-navigation/native";
import { useAuth } from "../state/auth";
import LoginScreen from "../screens/LoginScreen";
import Tabs from "./Tabs";

export default function RootNavigator() {
  const { session, ready } = useAuth();
  if (!ready) return null;
  return <NavigationContainer>{session?.token ? <Tabs /> : <LoginScreen />}</NavigationContainer>;
}
