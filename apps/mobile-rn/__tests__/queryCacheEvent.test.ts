import { shouldReconcileUnreadFromQueryCacheEvent } from "../src/logic/queryCacheEvent";

test("only reconciles unread state for data updates on settings and conversations", () => {
  expect(shouldReconcileUnreadFromQueryCacheEvent(null)).toBe(false);
  expect(shouldReconcileUnreadFromQueryCacheEvent({
    type: "observerResultsUpdated",
    query: { queryKey: ["conversations"] },
  })).toBe(false);
  expect(shouldReconcileUnreadFromQueryCacheEvent({
    type: "updated",
    action: { type: "fetch" },
    query: { queryKey: ["conversations"] },
  })).toBe(false);
  expect(shouldReconcileUnreadFromQueryCacheEvent({
    type: "updated",
    action: { type: "success" },
    query: { queryKey: ["friends"] },
  })).toBe(false);
  expect(shouldReconcileUnreadFromQueryCacheEvent({
    type: "updated",
    action: { type: "setState" },
    query: { queryKey: ["settings"] },
  })).toBe(true);
  expect(shouldReconcileUnreadFromQueryCacheEvent({
    type: "updated",
    action: { type: "success" },
    query: { queryKey: ["conversations"] },
  })).toBe(true);
});
