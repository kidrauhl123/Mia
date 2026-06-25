import React, { createContext, useContext, useMemo } from "react";
import { useAuth } from "../state/auth";
import { useUserSettings } from "../state/queries";
import { createTelegramTypography, normalizeTelegramFontSize } from "../theme";

const DEFAULT_TYPOGRAPHY = createTelegramTypography();
const Ctx = createContext(DEFAULT_TYPOGRAPHY);

function fontSizeFromAppearance(appearance: Record<string, unknown> | undefined) {
  return normalizeTelegramFontSize(appearance?.mobileFontSize ?? appearance?.fontSize);
}

export function TypographyProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const settings = useUserSettings({ enabled: Boolean(session?.token) });
  const fontSize = fontSizeFromAppearance(settings.data?.appearance);
  const value = useMemo(() => createTelegramTypography(fontSize), [fontSize]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTypography() {
  return useContext(Ctx);
}
