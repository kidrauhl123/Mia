import { QueryClient } from "@tanstack/react-query";
import { hydrateStartupCache } from "../src/state/startupCache";
import { loadCachedConversations, loadCachedValue, sqliteCacheKeys } from "../src/storage/sqliteCache";

jest.mock("../src/storage/sqliteCache", () => ({
  loadCachedConversations: jest.fn(),
  loadCachedMessages: jest.fn(),
  loadCachedValue: jest.fn(),
  replaceCachedConversations: jest.fn(),
  replaceCachedMessages: jest.fn(),
  saveCachedValue: jest.fn(),
  sqliteCacheKeys: {
    bots: "bots",
    friends: "friends",
    me: "me-full",
    settings: "settings",
  },
  upsertCachedConversation: jest.fn(),
}));

const mockedLoadCachedConversations = loadCachedConversations as jest.MockedFunction<typeof loadCachedConversations>;
const mockedLoadCachedValue = loadCachedValue as jest.MockedFunction<typeof loadCachedValue>;

beforeEach(() => {
  jest.resetAllMocks();
});

test("hydrates non-empty persisted chat cache before navigation renders", async () => {
  const qc = new QueryClient();
  const conversations = [{ id: "c1", title: "缓存会话" }];
  const bots = [{ id: "b1", name: "Bot" }];
  const friends = [{ id: "u2", username: "friend" }];
  const me = { id: "u1", username: "me" };
  const settings = { pins: ["c1"] };

  mockedLoadCachedConversations.mockResolvedValue(conversations as any);
  mockedLoadCachedValue.mockImplementation(async (_scope, key) => {
    if (key === sqliteCacheKeys.bots) return bots as any;
    if (key === sqliteCacheKeys.friends) return friends as any;
    if (key === sqliteCacheKeys.me) return me as any;
    if (key === sqliteCacheKeys.settings) return settings as any;
    return undefined;
  });

  await hydrateStartupCache(qc, "u1");

  expect(qc.getQueryData(["conversations"])).toEqual(conversations);
  expect(qc.getQueryData(["bots"])).toEqual(bots);
  expect(qc.getQueryData(["friends"])).toEqual(friends);
  expect(qc.getQueryData(["me-full"])).toEqual(me);
  expect(qc.getQueryData(["settings"])).toEqual(settings);
  expect(qc.getQueryState(["conversations"])?.dataUpdatedAt).toBe(1);
});

test("does not seed empty conversation cache as a real loaded list", async () => {
  const qc = new QueryClient();

  mockedLoadCachedConversations.mockResolvedValue([]);
  mockedLoadCachedValue.mockResolvedValue(undefined);

  await hydrateStartupCache(qc, "u1");

  expect(qc.getQueryData(["conversations"])).toBeUndefined();
});

test("does not overwrite live in-memory query data with persisted cache", async () => {
  const qc = new QueryClient();
  const live = [{ id: "live", title: "实时会话" }];
  const persisted = [{ id: "cached", title: "缓存会话" }];

  qc.setQueryData(["conversations"], live);
  mockedLoadCachedConversations.mockResolvedValue(persisted as any);
  mockedLoadCachedValue.mockResolvedValue(undefined);

  await hydrateStartupCache(qc, "u1");

  expect(qc.getQueryData(["conversations"])).toEqual(live);
});
