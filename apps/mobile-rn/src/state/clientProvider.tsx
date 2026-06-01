import React, { createContext, useContext, useMemo } from "react";
import { createCloudClient, type CloudClient } from "../api/client";
import { useAuth } from "./auth";

const Ctx = createContext<CloudClient>(null as any);

export function ApiProvider({ children }: { children: React.ReactNode }) {
  const { apiBase, session } = useAuth();
  const client = useMemo(
    () => createCloudClient({ apiBase, getToken: () => session?.token || "" }),
    [apiBase, session?.token]
  );
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>;
}

export const useApi = () => useContext(Ctx);
