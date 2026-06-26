import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import * as SecureStore from "expo-secure-store";
import {
  createTelegramTypography,
  localTypographyFontSizeFromStoredValue,
  normalizeTelegramFontSize,
  TELEGRAM_DEFAULT_FONT_SIZE,
  type TelegramFontSize,
} from "../theme";

const LOCAL_TYPOGRAPHY_KEY = "mia.mobile.typography";

const DEFAULT_TYPOGRAPHY = createTelegramTypography();
const Ctx = createContext(DEFAULT_TYPOGRAPHY);
const PrefCtx = createContext<{
  fontSize: TelegramFontSize;
  saving: boolean;
  setFontSize: (value: TelegramFontSize) => void;
}>({
  fontSize: TELEGRAM_DEFAULT_FONT_SIZE,
  saving: false,
  setFontSize: () => {},
});

export function TypographyProvider({ children }: { children: React.ReactNode }) {
  const [fontSize, setFontSizeState] = useState<TelegramFontSize>(TELEGRAM_DEFAULT_FONT_SIZE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    SecureStore.getItemAsync(LOCAL_TYPOGRAPHY_KEY)
      .then((raw) => {
        if (alive) setFontSizeState(localTypographyFontSizeFromStoredValue(raw));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const setFontSize = useCallback((value: TelegramFontSize) => {
    const next = normalizeTelegramFontSize(value);
    setFontSizeState(next);
    setSaving(true);
    SecureStore.setItemAsync(LOCAL_TYPOGRAPHY_KEY, JSON.stringify({ fontSize: next }))
      .catch(() => {})
      .finally(() => setSaving(false));
  }, []);

  const value = useMemo(() => createTelegramTypography(fontSize), [fontSize]);
  const preference = useMemo(() => ({ fontSize, saving, setFontSize }), [fontSize, saving, setFontSize]);
  return (
    <PrefCtx.Provider value={preference}>
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </PrefCtx.Provider>
  );
}

export function useTypography() {
  return useContext(Ctx);
}

export function useTypographyPreference() {
  return useContext(PrefCtx);
}
