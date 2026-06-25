import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as SecureStore from "expo-secure-store";
import { isDeprecatedApiBase } from "../logic/apiBase";

const KEY = "mia.session";
export const DEFAULT_API_BASE = "https://mia.gifgif.cn";

export interface Session {
  token: string;
  user: any;
  apiBase: string;
}

interface AuthCtx {
  session: Session | null;
  ready: boolean;
  setSession: (s: Session | null) => void;
  apiBase: string;
}

const Ctx = createContext<AuthCtx>(null as any);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const previousUserId = useRef<string | undefined>(undefined);
  const [session, setSessionState] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    SecureStore.getItemAsync(KEY)
      .then((raw) => {
        if (!raw) return;
        let parsed: Session | null = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }
        // A session pinned to a decommissioned backend can never reach the
        // current server with its old token — drop it so the user re-logs in
        // against DEFAULT_API_BASE instead of silently staying on the dead host.
        if (isDeprecatedApiBase(parsed?.apiBase)) {
          SecureStore.deleteItemAsync(KEY).catch(() => {});
          return;
        }
        setSessionState(parsed);
      })
      .finally(() => setReady(true));
  }, []);

  const setSession = (s: Session | null) => {
    setSessionState(s);
    if (s) SecureStore.setItemAsync(KEY, JSON.stringify(s));
    else SecureStore.deleteItemAsync(KEY);
  };

  useEffect(() => {
    const userId = String(session?.user?.id || "");
    if (previousUserId.current === undefined) {
      previousUserId.current = userId;
      return;
    }
    if (previousUserId.current !== userId) {
      previousUserId.current = userId;
      qc.clear();
    }
  }, [qc, session?.user?.id]);

  return (
    <Ctx.Provider value={{ session, ready, setSession, apiBase: session?.apiBase || DEFAULT_API_BASE }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
