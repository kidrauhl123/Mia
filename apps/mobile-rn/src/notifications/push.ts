import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import type { CloudClient } from "../api/client";

// Single Android channel for chat messages. Created at runtime (the config
// plugin only bundles the icon/color); HIGH importance so messages surface as a
// heads-up banner.
export const MESSAGES_CHANNEL_ID = "messages";

// Foreground presentation. The live event socket already rendered the message
// in-list, but showing a banner keeps parity with every other IM app — users
// expect to see a heads-up even with the app open on another screen.
export function configureNotificationHandler() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

export async function ensureAndroidChannel() {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(MESSAGES_CHANNEL_ID, {
    name: "消息",
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
  });
}

// Ask permission and fetch this device's Expo push token. Returns null when the
// user declines, on a simulator/emulator (no push hardware), or on any error —
// push is best-effort and must never block app usage.
export async function acquireExpoPushToken(projectId: string): Promise<string | null> {
  if (!Device.isDevice) return null;
  try {
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== "granted") return null;
    const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    return token?.data || null;
  } catch {
    return null;
  }
}

export async function registerPushToken(
  client: CloudClient,
  token: string,
  meta: { platform: string; deviceName?: string }
): Promise<void> {
  await client.api("/api/me/push-token", {
    method: "POST",
    body: { token, platform: meta.platform, deviceName: meta.deviceName || "" },
  });
}

export async function unregisterPushToken(client: CloudClient, token: string): Promise<void> {
  await client.api("/api/me/push-token", { method: "DELETE", body: { token } });
}
