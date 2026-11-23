/**
 * End-to-End Encryption (E2EE) & Pairing Cryptography for pi-remote.v1.
 * Suite: X25519 + HKDF-SHA256 + AES-256-GCM (random 96-bit IV + bound AAD + replay window).
 * Compatible with Node >= 22, modern browsers, and React Native (via WebCrypto polyfill or injected crypto).
 */

import { x25519, x25519PublicKey, isAllZeroBytes } from "./x25519.mjs";

export const E2EE_ALG = "X25519-HKDF-SHA256-AES256GCM";
export const PROTOCOL_VERSION = 1;

let cachedEncoder = null;
let cachedDecoder = null;

function getCrypto(override) {
  const c = override || globalThis.crypto;
  if (!c || !c.subtle || typeof c.getRandomValues !== "function") {
    throw new Error("WebCrypto API (crypto.subtle & crypto.getRandomValues) is unavailable");
  }
  return c;
}

export function utf8ToBytes(str) {
  if (typeof TextEncoder === "function") {
    cachedEncoder ??= new TextEncoder();
    return cachedEncoder.encode(str);
  }
  const s = String(str ?? "");
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
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
    } else if (cp >= 0xd800 && cp <= 0xdfff) {
      out.push(0xef, 0xbf, 0xbd);
    } else {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return new Uint8Array(out);
}

export function bytesToUtf8(bytes) {
  if (typeof TextDecoder === "function") {
    cachedDecoder ??= new TextDecoder();
    return cachedDecoder.decode(bytes);
  }
  const view = ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  let out = "";
  let i = 0;
  while (i < view.length) {
    const b0 = view[i++];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if ((b0 & 0xe0) === 0xc0 && i < view.length) {
      const b1 = view[i++];
      out += (b1 & 0xc0) === 0x80 ? String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f)) : "\ufffd";
    } else if ((b0 & 0xf0) === 0xe0 && i + 1 < view.length) {
      const b1 = view[i++];
      const b2 = view[i++];
      out +=
        (b1 & 0xc0) === 0x80 && (b2 & 0xc0) === 0x80
          ? String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f))
          : "\ufffd";
    } else if ((b0 & 0xf8) === 0xf0 && i + 2 < view.length) {
      const b1 = view[i++];
      const b2 = view[i++];
      const b3 = view[i++];
      const cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      if ((b1 & 0xc0) === 0x80 && (b2 & 0xc0) === 0x80 && (b3 & 0xc0) === 0x80 && cp >= 0x10000 && cp <= 0x10ffff) {
        const u = cp - 0x10000;
        out += String.fromCharCode(0xd800 | (u >> 10), 0xdc00 | (u & 0x3ff));
      } else {
        out += "\ufffd";
      }
    } else {
      out += "\ufffd";
    }
  }
  return out;
}

export function concatBytes(...arrays) {
  let total = 0;
  for (const arr of arrays) total += arr.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

export function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  if (typeof b64 !== "string" || b64.length === 0) {
    throw new TypeError("Expected non-empty base64 string");
  }
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(b64u) {
  const padded = b64u.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64u.length % 4)) % 4);
  return base64ToBytes(padded);
}

export function bytesToHex(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new TypeError("Invalid hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function randomBytes(length, cryptoImpl) {
  const c = getCrypto(cryptoImpl);
  const out = new Uint8Array(length);
  c.getRandomValues(out);
  return out;
}

export function randomId(byteLen = 16, cryptoImpl) {
  return bytesToBase64Url(randomBytes(byteLen, cryptoImpl));
}

export function constantTimeEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export function generateX25519KeyPair(cryptoImpl) {
  const privateKey = randomBytes(32, cryptoImpl);
  const publicKey = x25519PublicKey(privateKey);
  return {
    privateKey,
    publicKey,
    privateKeyB64: bytesToBase64(privateKey),
    publicKeyB64: bytesToBase64(publicKey),
  };
}

export function computeSharedSecret(privateKey, peerPublicKey) {
  const shared = x25519(privateKey, peerPublicKey);
  if (isAllZeroBytes(shared)) {
    throw new Error("Rejected low-order X25519 peer public key (all-zero shared secret)");
  }
  return shared;
}

export async function sha256(bytes, cryptoImpl) {
  const c = getCrypto(cryptoImpl);
  const buf = await c.subtle.digest("SHA-256", bytes);
  return new Uint8Array(buf);
}

export async function sha256Hex(input, cryptoImpl) {
  const bytes = typeof input === "string" ? utf8ToBytes(input) : input;
  return bytesToHex(await sha256(bytes, cryptoImpl));
}

export async function hmacSha256(keyBytes, dataBytes, cryptoImpl) {
  const c = getCrypto(cryptoImpl);
  const key = await c.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await c.subtle.sign("HMAC", key, dataBytes);
  return new Uint8Array(sig);
}

export async function hkdfSha256(ikm, salt, info, lengthBytes, cryptoImpl) {
  const c = getCrypto(cryptoImpl);
  const baseKey = await c.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await c.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info,
    },
    baseKey,
    lengthBytes * 8
  );
  return new Uint8Array(bits);
}

/**
 * Compute pairing proof proving knowledge of one-time QR inviteSecret without transmitting it in plaintext.
 */
export async function computeInviteProof({ inviteSecret, inviteId, hostId, deviceId, clientDhPubB64 }, cryptoImpl) {
  const secretBytes = typeof inviteSecret === "string" ? base64ToBytes(inviteSecret) : inviteSecret;
  const transcript = utf8ToBytes(`pi-remote-v1-proof|${inviteId}|${hostId}|${deviceId}|${clientDhPubB64}`);
  const mac = await hmacSha256(secretBytes, transcript, cryptoImpl);
  return bytesToBase64(mac);
}

export async function verifyInviteProof(params, expectedProofB64, cryptoImpl) {
  try {
    const computed = await computeInviteProof(params, cryptoImpl);
    return constantTimeEqual(base64ToBytes(computed), base64ToBytes(expectedProofB64));
  } catch {
    return false;
  }
}

/**
 * Derive symmetric AES-256-GCM session key, keyId, and 6-digit SAS verification code from X25519 + inviteSecret.
 * Both Host and Mobile independently compute identical values and compare the 6-digit SAS visually.
 */
export async function derivePairingMaterial(
  { sharedSecret, inviteSecret, inviteId, hostId, deviceId, hostDhPubB64, clientDhPubB64 },
  cryptoImpl
) {
  const salt = typeof inviteSecret === "string" ? base64ToBytes(inviteSecret) : inviteSecret;
  const info = utf8ToBytes(
    `pi-remote-v1-session|${inviteId}|${hostId}|${deviceId}|${hostDhPubB64}|${clientDhPubB64}`
  );
  // 32B AES-256 key + 8B keyId + 4B SAS entropy = 44 bytes
  const okm = await hkdfSha256(sharedSecret, salt, info, 44, cryptoImpl);
  const sessionKey = okm.slice(0, 32);
  const keyId = bytesToHex(okm.slice(32, 40));
  const sasRaw =
    ((okm[40] << 24) | (okm[41] << 16) | (okm[42] << 8) | okm[43]) >>> 0;
  const sasCode = String(sasRaw % 1_000_000).padStart(6, "0");

  return {
    sessionKey,
    sessionKeyB64: bytesToBase64(sessionKey),
    keyId,
    sasCode,
  };
}

/**
 * Build Associated Authenticated Data (AAD) binding cipher envelope metadata.
 * Direction MUST be "h2c" (host->client) or "c2h" (client->host) to prevent reflection attacks.
 */
export function buildEnvelopeAad({ v = PROTOCOL_VERSION, hostId, deviceId, direction, seq }) {
  if (direction !== "h2c" && direction !== "c2h") {
    throw new TypeError(`Invalid direction: ${direction}`);
  }
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new TypeError(`Invalid seq: ${seq}`);
  }
  return utf8ToBytes(`pi-e2ee|v${v}|${hostId}|${deviceId}|${direction}|${seq}`);
}

/**
 * Encrypt JSON-serializable plaintext into a pi-remote.v1 CipherEnvelope.
 * Uses fresh cryptographically random 96-bit IV (NEVER derived from seq/cursor).
 */
export async function encryptEnvelope(
  { keyBytes, keyId, hostId, deviceId, direction, seq, payload },
  cryptoImpl
) {
  const c = getCrypto(cryptoImpl);
  const rawKey = typeof keyBytes === "string" ? base64ToBytes(keyBytes) : keyBytes;
  if (rawKey.length !== 32) {
    throw new TypeError("AES-256-GCM key must be 32 bytes");
  }
  const iv = randomBytes(12, c);
  const aad = buildEnvelopeAad({ v: PROTOCOL_VERSION, hostId, deviceId, direction, seq });
  const plaintext = utf8ToBytes(JSON.stringify(payload));

  const cryptoKey = await c.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(
    await c.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, cryptoKey, plaintext)
  );
  // WebCrypto appends 16-byte GCM auth tag at the end of ciphertext
  const ct = sealed.slice(0, sealed.length - 16);
  const tag = sealed.slice(sealed.length - 16);

  return {
    v: PROTOCOL_VERSION,
    alg: E2EE_ALG,
    kid: keyId,
    dir: direction,
    seq,
    iv: bytesToBase64(iv),
    ct: bytesToBase64(ct),
    tag: bytesToBase64(tag),
  };
}

/**
 * Decrypt and authenticate a CipherEnvelope. Throws if tampered, wrong key, or wrong AAD.
 */
export async function decryptEnvelope(
  { keyBytes, keyId, hostId, deviceId, expectedDirection, envelope, replayWindow },
  cryptoImpl
) {
  if (!envelope || typeof envelope !== "object") {
    throw new Error("Missing cipher envelope");
  }
  if (envelope.v !== PROTOCOL_VERSION || envelope.alg !== E2EE_ALG) {
    throw new Error(`Unsupported cipher suite v=${envelope.v} alg=${envelope.alg}`);
  }
  if (keyId && envelope.kid !== keyId) {
    throw new Error("Key ID mismatch");
  }
  if (envelope.dir !== expectedDirection) {
    throw new Error(`Direction mismatch: expected ${expectedDirection}, got ${envelope.dir}`);
  }
  if (!Number.isSafeInteger(envelope.seq) || envelope.seq < 1) {
    throw new Error("Invalid envelope sequence number");
  }
  if (replayWindow && !replayWindow.canAccept(envelope.seq)) {
    throw new Error(`Replay detected for seq=${envelope.seq}`);
  }

  const c = getCrypto(cryptoImpl);
  const rawKey = typeof keyBytes === "string" ? base64ToBytes(keyBytes) : keyBytes;
  const iv = base64ToBytes(envelope.iv);
  const ct = base64ToBytes(envelope.ct);
  const tag = base64ToBytes(envelope.tag);
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error("Invalid AES-GCM IV or tag length");
  }

  const aad = buildEnvelopeAad({
    v: envelope.v,
    hostId,
    deviceId,
    direction: expectedDirection,
    seq: envelope.seq,
  });
  const combined = concatBytes(ct, tag);
  const cryptoKey = await c.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  const plainBuf = await c.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
    cryptoKey,
    combined
  );

  // Only advance replay window AFTER authentication succeeds!
  if (replayWindow) {
    replayWindow.record(envelope.seq);
  }

  return JSON.parse(bytesToUtf8(new Uint8Array(plainBuf)));
}

/**
 * 64-slot sliding anti-replay window (RFC 6479 style) for per-direction monotonic envelope sequences.
 */
export class ReplayWindow {
  constructor(windowSize = 64) {
    this.windowSize = windowSize;
    this.highest = 0;
    this.seen = new Set();
  }

  canAccept(seq) {
    if (!Number.isSafeInteger(seq) || seq < 1) return false;
    if (seq > this.highest) return true;
    if (this.highest - seq >= this.windowSize) return false;
    return !this.seen.has(seq);
  }

  record(seq) {
    if (!this.canAccept(seq)) {
      throw new Error(`Cannot record duplicate or stale seq=${seq}`);
    }
    if (seq > this.highest) {
      this.highest = seq;
      const floor = this.highest - this.windowSize;
      for (const s of this.seen) {
        if (s <= floor) this.seen.delete(s);
      }
    }
    this.seen.add(seq);
  }
}
