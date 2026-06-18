export const conversationSearchOverlayChrome = {
  surface: "overlay",
  focusOnOpen: true,
  backCloses: true,
  keyboardHideCloses: true,
  focusDelayMs: 90,
  searchBox: {
    height: 34,
    radius: 14,
    iconColumnWidth: 24,
    clearButtonSize: 22,
    searchIconSize: 15,
    clearIconSize: 13,
    closeIconSize: 18,
  },
  animation: {
    kind: "accordion",
    durationMs: 190,
  },
} as const;

export function conversationSearchPresentation<T>({
  active,
  query,
  items,
  isLoading,
}: {
  active: boolean;
  query: string;
  items: T[];
  isLoading: boolean;
}) {
  const trimmed = String(query || "").trim();
  if (active) {
    return {
      items: trimmed ? items : [],
      emptyText: trimmed ? "没有匹配的会话" : "",
      mode: "search" as const,
    };
  }
  return {
    items,
    emptyText: isLoading ? "加载中…" : "还没有会话",
    mode: "normal" as const,
  };
}
