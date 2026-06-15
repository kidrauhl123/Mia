import { createNavigationContainerRef } from "@react-navigation/native";

// Shared ref so non-component code (push-notification taps) can drive
// navigation. Attached to the NavigationContainer in RootNavigator.
export const navigationRef = createNavigationContainerRef();

// Deep-link a push-notification tap to its conversation. No-ops if navigation
// isn't mounted yet; the cold-start tap is replayed once the tree is ready.
export function openConversationFromPush(
  data: { conversationId?: unknown; title?: unknown } | undefined
): void {
  const conversationId = typeof data?.conversationId === "string" ? data.conversationId : "";
  if (!conversationId || !navigationRef.isReady()) return;
  const title = typeof data?.title === "string" ? data.title : "";
  // Loose cast: the container ref is untyped (no root param list), so the
  // nested navigate signature would otherwise resolve to `never`.
  const navigate = navigationRef.navigate as (name: string, params?: object) => void;
  navigate("Messages", { screen: "Chat", params: { conversationId, title } });
}
