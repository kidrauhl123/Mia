import React, { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { useAuth } from "../state/auth";
import { useApi } from "../state/clientProvider";
import { openConversationFromPush } from "../navigation/navigationRef";
import {
  acquireExpoPushToken,
  configureNotificationHandler,
  ensureAndroidChannel,
  registerPushToken,
  unregisterPushToken,
} from "./push";

interface PushCtx {
  // Unregister this device's token (best-effort) then clear the session. Call
  // this for logout so a signed-out phone stops receiving the account's pushes.
  logout: () => Promise<void>;
}

const Ctx = createContext<PushCtx>({ logout: async () => {} });

function projectId(): string {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId || "";
}

// Foreground banner behaviour + Android channel only need to be set up once.
configureNotificationHandler();

export function PushProvider({ children }: { children: React.ReactNode }) {
  const { session, setSession } = useAuth();
  const client = useApi();
  const tokenRef = useRef<string | null>(null);
  const registeredForToken = useRef<string | null>(null);

  useEffect(() => {
    ensureAndroidChannel().catch(() => {});
  }, []);

  // Register this device whenever a session is active. Keyed on the auth token
  // so re-login as another account re-points the device to the new user.
  useEffect(() => {
    const authToken = session?.token;
    if (!authToken || registeredForToken.current === authToken) return;
    let cancelled = false;
    (async () => {
      const expoToken = await acquireExpoPushToken(projectId());
      if (cancelled || !expoToken) return;
      try {
        await registerPushToken(client, expoToken, {
          platform: Platform.OS,
          deviceName: Constants.deviceName || "",
        });
        tokenRef.current = expoToken;
        registeredForToken.current = authToken;
      } catch {
        // Best-effort; a failed registration retries on the next session change.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.token, client]);

  // Route taps (warm and cold start) to the conversation.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      openConversationFromPush(response.notification.request.content.data as any);
    });
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) openConversationFromPush(response.notification.request.content.data as any);
    });
    return () => sub.remove();
  }, []);

  const logout = useCallback(async () => {
    const expoToken = tokenRef.current;
    if (expoToken) {
      await unregisterPushToken(client, expoToken).catch(() => {});
      tokenRef.current = null;
    }
    registeredForToken.current = null;
    setSession(null);
  }, [client, setSession]);

  return <Ctx.Provider value={{ logout }}>{children}</Ctx.Provider>;
}

export const usePush = () => useContext(Ctx);
