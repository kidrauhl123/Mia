import { conversationSearchOverlayChrome, conversationSearchPresentation } from "../src/logic/conversationSearchMode";

const item = (id: string) => ({ id });

test("搜索未激活时展示普通会话列表", () => {
  expect(conversationSearchPresentation({
    active: false,
    query: "",
    items: [item("a"), item("b")],
    isLoading: false,
  })).toEqual({
    items: [item("a"), item("b")],
    emptyText: "还没有会话",
    mode: "normal",
  });
});

test("搜索激活但没有输入时隐藏普通列表并进入搜索空态", () => {
  expect(conversationSearchPresentation({
    active: true,
    query: "",
    items: [item("a")],
    isLoading: false,
  })).toEqual({
    items: [],
    emptyText: "",
    mode: "search",
  });
});

test("搜索激活且有输入时展示过滤后的结果", () => {
  expect(conversationSearchPresentation({
    active: true,
    query: "论文",
    items: [item("match")],
    isLoading: false,
  })).toEqual({
    items: [item("match")],
    emptyText: "没有匹配的会话",
    mode: "search",
  });
});

test("搜索界面是覆盖层, 聚焦且返回关闭", () => {
  expect(conversationSearchOverlayChrome.surface).toBe("overlay");
  expect(conversationSearchOverlayChrome.focusOnOpen).toBe(true);
  expect(conversationSearchOverlayChrome.backCloses).toBe(true);
  expect(conversationSearchOverlayChrome.keyboardHideCloses).toBe(true);
  expect(conversationSearchOverlayChrome.searchBox).toMatchObject({
    height: 34,
    radius: 14,
    iconColumnWidth: 24,
    clearButtonSize: 22,
    searchIconSize: 15,
    clearIconSize: 13,
    closeIconSize: 18,
  });
  expect(conversationSearchOverlayChrome.animation.kind).toBe("accordion");
  expect(conversationSearchOverlayChrome.animation.durationMs).toBeGreaterThanOrEqual(160);
  expect(conversationSearchOverlayChrome.animation.durationMs).toBeLessThanOrEqual(260);
});
