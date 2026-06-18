import { conversationHomeChrome } from "../src/logic/conversationHomeChrome";

test("消息首页使用紧凑 chrome", () => {
  expect(conversationHomeChrome.nativeHeaderShown).toBe(false);
  expect(conversationHomeChrome.search.leadingLabel).toBe("");
  expect(conversationHomeChrome.search.placeholder).toBe("搜索");
  expect(conversationHomeChrome.search.height).toBe(34);
  expect(conversationHomeChrome.search.radius).toBe(14);
  expect(conversationHomeChrome.row.separatorWidth).toBe(0);
  expect(conversationHomeChrome.row.shadowOpacity).toBe(0);
  expect(conversationHomeChrome.page.backgroundColor).toBe("#FFFFFF");
  expect(conversationHomeChrome.title.fontSize).toBe(16);
});
