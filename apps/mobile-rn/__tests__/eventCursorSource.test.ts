import fs from "node:fs";
import path from "node:path";

test("mobile advances the replay cursor only after applying the event", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/state/events.tsx"), "utf8");
  const handlerStart = source.indexOf("onEvent: (env) =>");
  const handlerEnd = source.indexOf("} catch (err)", handlerStart);
  expect(handlerStart).toBeGreaterThanOrEqual(0);
  expect(handlerEnd).toBeGreaterThan(handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  expect(handler).toContain('t === "conversation.message_appended"');
  expect(handler).toContain("advanceLastSeq(env?.seq)");
  expect(handler.indexOf('t === "conversation.message_appended"')).toBeLessThan(handler.indexOf("advanceLastSeq(env?.seq)"));
});
