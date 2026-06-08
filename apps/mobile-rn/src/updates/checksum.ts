declare const require: any;

export function hexFromArrayBuffer(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256File(uri: string): Promise<string> {
  const { File } = require("expo-file-system");
  const Crypto = require("expo-crypto");
  const bytes = await new File(uri).bytes();
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  return hexFromArrayBuffer(digest).toLowerCase();
}
