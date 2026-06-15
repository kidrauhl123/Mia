import React, { createContext, useContext, useMemo } from "react";
import { createCloudClient, type CloudClient } from "../api/client";
import { useAuth } from "./auth";

const Ctx = createContext<CloudClient>(null as any);

export function ApiProvider({ children }: { children: React.ReactNode }) {
  const { apiBase, session, setSession } = useAuth();
  const token = session?.token || "";
  const client = useMemo(() => {
    const base = createCloudClient({ apiBase, getToken: () => token });
    const call = base.api.bind(base);
    // Any authenticated request that comes back 401 means the stored token is
    // invalid/expired. Clear the session so RootNavigator falls back to the
    // login screen, instead of leaving the user stuck on "请先登录" with no way out.
    base.api = (path: string, options?: Record<string, any>) =>
      call(path, options).catch((e: any) => {
        if (e?.status === 401 && token) setSession(null);
        throw e;
      });
    return base;
  }, [apiBase, token, setSession]);
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>;
}

export const useApi = () => useContext(Ctx);
