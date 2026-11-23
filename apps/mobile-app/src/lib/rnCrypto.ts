import { getRandomValues } from "expo-crypto";

// Metro loads the same ESM module exercised by Node's interoperability tests.
const { createNobleWebCrypto }: {
  createNobleWebCrypto(random: typeof getRandomValues): { getRandomValues: typeof getRandomValues; subtle: object };
} = require("./rnCryptoCore.mjs");

export function installRnCryptoPolyfill(): void {
  // protocol's Hermes path uses browser-style base64 when Node's Buffer is absent.
  if (typeof globalThis.atob !== "function" || typeof globalThis.btoa !== "function") {
    const base64: { decode(value: string): string; encode(value: string): string } = require("base-64");
    globalThis.atob ??= base64.decode;
    globalThis.btoa ??= base64.encode;
  }
  const existing = globalThis.crypto;
  if (existing?.subtle) return;
  const adapter = createNobleWebCrypto(getRandomValues);
  if (existing) {
    Object.defineProperty(existing, "subtle", { configurable: true, value: adapter.subtle });
    if (typeof existing.getRandomValues !== "function") {
      Object.defineProperty(existing, "getRandomValues", { configurable: true, value: adapter.getRandomValues });
    }
  } else {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: adapter });
  }
}

installRnCryptoPolyfill();
