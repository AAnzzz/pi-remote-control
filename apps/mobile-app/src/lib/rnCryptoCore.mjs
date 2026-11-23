import { sha256 } from "@noble/hashes/sha2";
import { hmac } from "@noble/hashes/hmac";
import { hkdf } from "@noble/hashes/hkdf";
import { gcm } from "@noble/ciphers/aes";

function bytes(source) {
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  throw new TypeError("Expected an ArrayBuffer or view");
}

function algorithmName(algorithm) {
  return typeof algorithm === "string" ? algorithm : algorithm?.name;
}

function requireAlgorithm(algorithm, name) {
  if (algorithmName(algorithm) !== name) throw new TypeError(`Expected ${name}`);
}

// Deliberately limited to the algorithms and non-extractable raw keys used by pi-remote.v1.
export function createNobleWebCrypto(getRandomValuesFn) {
  if (typeof getRandomValuesFn !== "function") throw new TypeError("A secure random source is required");
  const keys = new WeakMap();
  const supportedUsages = new Map([["HMAC", ["sign"]], ["HKDF", ["deriveBits"]], ["AES-GCM", ["encrypt", "decrypt"]]]);

  function keyBytes(handle, name, usage) {
    const key = keys.get(handle);
    if (key?.name !== name || !key.usages.includes(usage)) throw new TypeError(`Key cannot be used for ${usage}`);
    return key.raw;
  }

  function aes(algorithm, key, usage) {
    requireAlgorithm(algorithm, "AES-GCM");
    if ((algorithm.tagLength ?? 128) !== 128) throw new TypeError("Expected a 128-bit GCM tag");
    return gcm(keyBytes(key, "AES-GCM", usage), bytes(algorithm.iv),
      algorithm.additionalData === undefined ? undefined : bytes(algorithm.additionalData));
  }

  return {
    getRandomValues(array) {
      getRandomValuesFn(array);
      return array;
    },
    subtle: {
      async digest(algorithm, data) {
        requireAlgorithm(algorithm, "SHA-256");
        return sha256(bytes(data)).buffer;
      },
      async importKey(format, data, algorithm, extractable, usages) {
        const name = algorithmName(algorithm);
        const allowed = supportedUsages.get(name);
        if (format !== "raw" || extractable || !allowed || !usages.length || !usages.every(u => allowed.includes(u))) {
          throw new TypeError("Unsupported key format, algorithm or usage");
        }
        const raw = bytes(data);
        if (name === "HMAC") {
          requireAlgorithm(algorithm.hash, "SHA-256");
          if (!raw.length) throw new TypeError("Empty HMAC key");
        }
        if (name === "AES-GCM" && ![16, 24, 32].includes(raw.length)) throw new TypeError("Invalid AES key length");
        const handle = Object.freeze({});
        keys.set(handle, { name, raw: raw.slice(), usages: [...usages] });
        return handle;
      },
      async sign(algorithm, key, data) {
        requireAlgorithm(algorithm, "HMAC");
        return hmac(sha256, keyBytes(key, "HMAC", "sign"), bytes(data)).buffer;
      },
      async deriveBits(algorithm, key, bitLength) {
        requireAlgorithm(algorithm, "HKDF");
        requireAlgorithm(algorithm.hash, "SHA-256");
        if (!Number.isSafeInteger(bitLength) || bitLength <= 0 || bitLength % 8) throw new TypeError("Invalid bit length");
        return hkdf(sha256, keyBytes(key, "HKDF", "deriveBits"), bytes(algorithm.salt), bytes(algorithm.info), bitLength / 8).buffer;
      },
      async encrypt(algorithm, key, data) {
        return aes(algorithm, key, "encrypt").encrypt(bytes(data)).buffer;
      },
      async decrypt(algorithm, key, data) {
        // Noble may return a subarray of a buffer that also held the tag. Return only plaintext bytes.
        return aes(algorithm, key, "decrypt").decrypt(bytes(data)).slice().buffer;
      },
    },
  };
}
