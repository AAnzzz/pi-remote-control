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

// Standard UTF-8 encode/decode for Hermes runtimes where TextEncoder is absent.
export function utf8Encode(input) {
  const str = String(input ?? "");
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        );
      } else {
        out.push(0xef, 0xbf, 0xbd);
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      out.push(0xef, 0xbf, 0xbd);
    } else {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return new Uint8Array(out);
}

export function utf8Decode(source) {
  if (source === undefined || source === null) return "";
  const view = bytes(source);
  let out = "";
  let i = 0;
  while (i < view.length) {
    const b0 = view[i++];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if ((b0 & 0xe0) === 0xc0 && i < view.length) {
      const b1 = view[i++];
      if ((b1 & 0xc0) !== 0x80) {
        out += "\ufffd";
        i--;
        continue;
      }
      const cp = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
      out += cp < 0x80 ? "\ufffd" : String.fromCharCode(cp);
    } else if ((b0 & 0xf0) === 0xe0 && i + 1 < view.length) {
      const b1 = view[i++];
      const b2 = view[i++];
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) {
        out += "\ufffd";
        continue;
      }
      const cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
      out += cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff) ? "\ufffd" : String.fromCharCode(cp);
    } else if ((b0 & 0xf8) === 0xf0 && i + 2 < view.length) {
      const b1 = view[i++];
      const b2 = view[i++];
      const b3 = view[i++];
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) {
        out += "\ufffd";
        continue;
      }
      const cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      if (cp < 0x10000 || cp > 0x10ffff) {
        out += "\ufffd";
      } else {
        const u = cp - 0x10000;
        out += String.fromCharCode(0xd800 | (u >> 10), 0xdc00 | (u & 0x3ff));
      }
    } else {
      out += "\ufffd";
    }
  }
  return out;
}

export class TextEncoderPolyfill {
  get encoding() {
    return "utf-8";
  }
  encode(input = "") {
    return utf8Encode(input);
  }
  encodeInto(source, destination) {
    const encoded = utf8Encode(source);
    const written = Math.min(encoded.length, destination.length);
    destination.set(encoded.subarray(0, written));
    return { read: source.length, written };
  }
}

export class TextDecoderPolyfill {
  get encoding() {
    return "utf-8";
  }
  decode(input) {
    return utf8Decode(input);
  }
}
