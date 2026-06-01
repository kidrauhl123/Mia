import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "./src/state/auth";
import { ApiProvider } from "./src/state/clientProvider";
import { EventsProvider } from "./src/state/events";
import RootNavigator from "./src/navigation/RootNavigator";

const queryClient = new QueryClient();

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <ApiProvider>
              <EventsProvider>
                <StatusBar style="dark" />
                <RootNavigator />
              </EventsProvider>
            </ApiProvider>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
