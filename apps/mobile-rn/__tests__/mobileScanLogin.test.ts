import { mobileScanErrorMessage, parseMobileScanQr } from "../src/logic/mobileScanLogin";

test("parseMobileScanQr reads grant and apiBase from Mia desktop qr url", () => {
  expect(parseMobileScanQr("https://mia.example/mobile-scan?grant=ms_123")).toEqual({
    apiBase: "https://mia.example",
    grant: "ms_123",
  });
});

test("mobileScanErrorMessage keeps invalid qr copy concise", () => {
  expect(mobileScanErrorMessage("invalid")).toBe("这不是 Mia 登录码");
});
