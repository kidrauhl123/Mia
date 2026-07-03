import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { Fredoka_600SemiBold } from "@expo-google-fonts/fredoka";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "./src/state/auth";
import { ApiProvider } from "./src/state/clientProvider";
import { EventsProvider } from "./src/state/events";
import RootNavigator from "./src/navigation/RootNavigator";
import { UpdateProvider } from "./src/updates/UpdateProvider";
import { PushProvider } from "./src/notifications/PushProvider";
import { TypographyProvider } from "./src/ui/TypographyProvider";

const queryClient = new QueryClient();

export default function App() {
  const [brandFontLoaded] = useFonts({
    Fredoka_600SemiBold,
  });

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <ApiProvider>
              <TypographyProvider brandFontFamily={brandFontLoaded ? "Fredoka_600SemiBold" : undefined}>
                <PushProvider>
                  <UpdateProvider>
                    <EventsProvider>
                      <StatusBar style="dark" />
                      <RootNavigator />
                    </EventsProvider>
                  </UpdateProvider>
                </PushProvider>
              </TypographyProvider>
            </ApiProvider>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
