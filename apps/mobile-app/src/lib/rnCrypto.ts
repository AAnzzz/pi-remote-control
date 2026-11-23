import { getRandomValues } from "expo-crypto";

// Metro loads the same ESM module exercised by Node's interoperability tests.
const {
  createNobleWebCrypto,
  TextEncoderPolyfill,
  TextDecoderPolyfill,
}: {
  createNobleWebCrypto(random: typeof getRandomValues): { getRandomValues: typeof getRandomValues; subtle: object };
  TextEncoderPolyfill: new () => { encoding: string; encode(input?: string): Uint8Array };
  TextDecoderPolyfill: new () => { encoding: string; decode(input?: ArrayBufferView | ArrayBuffer): string };
} = require("./rnCryptoCore.mjs");

export function installRnCryptoPolyfill(): void {
  // Hermes on RN 0.79 / Expo 53 polyfills TextDecoder via Expo winter, but does NOT provide global TextEncoder.
  // Both @pi-remote/protocol, secureVault, and @noble/* rely on TextEncoder at runtime.
  if (typeof globalThis.TextEncoder !== "function") {
    Object.defineProperty(globalThis, "TextEncoder", {
      configurable: true,
      writable: true,
      value: TextEncoderPolyfill,
    });
  }
  if (typeof globalThis.TextDecoder !== "function") {
    Object.defineProperty(globalThis, "TextDecoder", {
      configurable: true,
      writable: true,
      value: TextDecoderPolyfill,
    });
  }

  // protocol's Hermes path uses browser-style base64 when Node's Buffer is absent.
  if (typeof globalThis.atob !== "function" || typeof globalThis.btoa !== "function") {
    const base64: { decode(value: string): string; encode(value: string): string } = require("base-64");
    globalThis.atob ??= base64.decode;
    globalThis.btoa ??= base64.encode;
  }

  const existing = globalThis.crypto;
  if (existing?.subtle && typeof existing.getRandomValues === "function") return;
  const adapter = createNobleWebCrypto(getRandomValues);
  if (existing) {
    try {
      if (!existing.subtle) {
        Object.defineProperty(existing, "subtle", { configurable: true, value: adapter.subtle });
      }
      if (typeof existing.getRandomValues !== "function") {
        Object.defineProperty(existing, "getRandomValues", { configurable: true, value: adapter.getRandomValues });
      }
      return;
    } catch {
      // Fall through to replace globalThis.crypto if existing object is frozen/non-extensible.
    }
  }
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    writable: true,
    value: adapter,
  });
}

installRnCryptoPolyfill();
