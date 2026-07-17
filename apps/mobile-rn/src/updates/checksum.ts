declare const require: any;

import { IncrementalSha256 } from "./sha256";

const SHA256_CHUNK_BYTES = 1024 * 1024;
const YIELD_AFTER_CHUNKS = 8;

export function hexFromArrayBuffer(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256File(uri: string): Promise<string> {
  const { File, FileMode } = require("expo-file-system");
  const handle = new File(uri).open(FileMode.ReadOnly);
  const digest = new IncrementalSha256();
  let chunks = 0;
  try {
    while (true) {
      const bytes: Uint8Array = handle.readBytes(SHA256_CHUNK_BYTES);
      if (!bytes.byteLength) break;
      digest.update(bytes);
      chunks += 1;
      if (chunks % YIELD_AFTER_CHUNKS === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    return digest.hex();
  } finally {
    handle.close();
  }
}
