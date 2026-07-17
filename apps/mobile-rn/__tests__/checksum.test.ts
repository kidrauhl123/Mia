import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { IncrementalSha256 } from "../src/updates/sha256";

function nodeSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test.each([
  new Uint8Array(),
  new TextEncoder().encode("abc"),
  new TextEncoder().encode("Mia 分块校验 APK"),
  Uint8Array.from({ length: 1025 }, (_, index) => (index * 37) & 0xff),
])("matches Node SHA-256 across uneven chunks", (input) => {
  const digest = new IncrementalSha256();
  const chunkSizes = [1, 7, 64, 3, 129];
  let offset = 0;
  let chunk = 0;
  while (offset < input.byteLength) {
    const end = Math.min(input.byteLength, offset + chunkSizes[chunk % chunkSizes.length]);
    digest.update(input.subarray(offset, end));
    offset = end;
    chunk += 1;
  }
  expect(digest.hex()).toBe(nodeSha256(input));
});

test("returns a stable digest after finalization and rejects later writes", () => {
  const digest = new IncrementalSha256().update(new TextEncoder().encode("mia"));
  const first = digest.hex();
  expect(digest.hex()).toBe(first);
  expect(() => digest.update(new Uint8Array([1]))).toThrow(/finalized/);
});

test("APK checksum reads bounded chunks instead of loading the whole file", () => {
  const source = readFileSync(path.join(__dirname, "../src/updates/checksum.ts"), "utf8");
  expect(source).toMatch(/readBytes\(SHA256_CHUNK_BYTES\)/);
  expect(source).not.toMatch(/\.bytes\(\)/);
});
