import fs from "node:fs";
import path from "node:path";

test("message pagination follows the server window cursor, not stale cache minimum", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/state/queries.ts"), "utf8");
  expect(source).toContain("messages?latest=1&limit=200");
  expect(source).toContain("Number(d.pageInfo?.oldestSeq)");
  expect(source).toContain("messages?before_seq=${oldestSeq}&limit=100");
  expect(source).toContain("Number(data.pageInfo?.oldestSeq)");
  expect(source).not.toContain("current.reduce((min, message)");
});

test("SQLite message cache retains and trims by authoritative sequence", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/storage/sqliteCache.ts"), "utf8");
  expect(source).toContain("ORDER BY seq DESC, sort_time DESC LIMIT ?");
  expect(source).toContain("AND seq BETWEEN ? AND ?");
});
