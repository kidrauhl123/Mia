import React, { createContext, useContext, useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";

const KEY = "mia.session";
export const DEFAULT_API_BASE = "https://aiweb.buytb01.com";

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
  const [session, setSessionState] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    SecureStore.getItemAsync(KEY)
      .then((raw) => {
        if (raw) {
          try {
            setSessionState(JSON.parse(raw));
          } catch {}
        }
      })
      .finally(() => setReady(true));
  }, []);

  const setSession = (s: Session | null) => {
    setSessionState(s);
    if (s) SecureStore.setItemAsync(KEY, JSON.stringify(s));
    else SecureStore.deleteItemAsync(KEY);
  };

  return (
    <Ctx.Provider value={{ session, ready, setSession, apiBase: session?.apiBase || DEFAULT_API_BASE }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
