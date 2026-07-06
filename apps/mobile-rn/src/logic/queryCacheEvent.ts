type QueryCacheEventLike = {
  type?: string;
  action?: { type?: string };
  query?: { queryKey?: readonly unknown[] };
} | null | undefined;

export function shouldReconcileUnreadFromQueryCacheEvent(event: QueryCacheEventLike): boolean {
  const key = event?.query?.queryKey;
  const actionType = event?.action?.type;
  if (event?.type !== "updated" || !Array.isArray(key)) return false;
  if (actionType !== "success" && actionType !== "setState") return false;
  return key[0] === "settings" || key[0] === "conversations";
}
