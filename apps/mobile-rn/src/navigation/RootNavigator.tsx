import { NavigationContainer } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../state/auth";
import { hydrateStartupCache } from "../state/startupCache";
import LoginScreen from "../screens/LoginScreen";
import Tabs from "./Tabs";
import { navigationRef } from "./navigationRef";
import { color } from "../theme";

function StartupSurface() {
  return <View style={styles.startup} />;
}

export default function RootNavigator() {
  const qc = useQueryClient();
  const { session, ready } = useAuth();
  const userId = String(session?.user?.id || "");
  const [hydratedUserId, setHydratedUserId] = useState("");

  useEffect(() => {
    if (!ready || !session?.token || !userId) {
      setHydratedUserId("");
      return undefined;
    }
    let cancelled = false;
    setHydratedUserId((current) => (current === userId ? current : ""));
    hydrateStartupCache(qc, userId).finally(() => {
      if (!cancelled) setHydratedUserId(userId);
    });
    return () => {
      cancelled = true;
    };
  }, [qc, ready, session?.token, userId]);

  if (!ready) return <StartupSurface />;
  const cacheReady = !session?.token || !userId || hydratedUserId === userId;
  if (!cacheReady) return <StartupSurface />;
  return (
    <NavigationContainer ref={navigationRef}>
      {session?.token ? <Tabs /> : <LoginScreen />}
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  startup: {
    flex: 1,
    backgroundColor: color.bg,
  },
});
