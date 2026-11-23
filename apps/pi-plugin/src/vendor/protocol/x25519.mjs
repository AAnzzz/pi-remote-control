/**
 * Pure JavaScript RFC 7748 X25519 (Curve25519 Diffie-Hellman).
 * Zero external dependencies, zero eval/new Function, identical output across Node, Web, and React Native.
 */

const P = (1n << 255n) - 19n;
const A24 = 121665n; // (486662 - 2) / 4
const BASEPOINT_U = 9n;

/**
 * Modular arithmetic helpers over GF(2^255 - 19).
 */
function mod(a) {
  const r = a % P;
  return r >= 0n ? r : r + P;
}

function modInv(a) {
  // Fermat's little theorem: a^(p-2) mod p
  return modPow(mod(a), P - 2n);
}

function modPow(base, exp) {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if ((e & 1n) === 1n) {
      result = (result * b) % P;
    }
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

function decodeLittleEndian(bytes) {
  let n = 0n;
  for (let i = 0; i < 32; i++) {
    n |= BigInt(bytes[i]) << BigInt(8 * i);
  }
  return n;
}

function encodeLittleEndian(n) {
  const out = new Uint8Array(32);
  let v = mod(n);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function clampScalar(scalarBytes) {
  if (!(scalarBytes instanceof Uint8Array) || scalarBytes.length !== 32) {
    throw new TypeError("X25519 scalar must be a 32-byte Uint8Array");
  }
  const k = new Uint8Array(scalarBytes);
  k[0] &= 248;
  k[31] &= 127;
  k[31] |= 64;
  return k;
}

/**
 * RFC 7748 Section 5 X25519 scalar multiplication.
 * @param {Uint8Array} scalarBytes 32-byte private key
 * @param {Uint8Array} uCoordBytes 32-byte peer public key (or basepoint)
 * @returns {Uint8Array} 32-byte shared point u-coordinate
 */
export function x25519(scalarBytes, uCoordBytes) {
  if (!(uCoordBytes instanceof Uint8Array) || uCoordBytes.length !== 32) {
    throw new TypeError("X25519 u-coordinate must be a 32-byte Uint8Array");
  }
  const clamped = clampScalar(scalarBytes);
  const k = decodeLittleEndian(clamped);

  const uBytes = new Uint8Array(uCoordBytes);
  uBytes[31] &= 127; // RFC 7748: mask most significant bit in final byte
  const u = decodeLittleEndian(uBytes) % P;

  let x1 = u;
  let x2 = 1n;
  let z2 = 0n;
  let x3 = u;
  let z3 = 1n;
  let swap = 0n;

  for (let t = 254; t >= 0; t--) {
    const kt = (k >> BigInt(t)) & 1n;
    swap ^= kt;
    if (swap === 1n) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }
    swap = kt;

    const A = mod(x2 + z2);
    const AA = mod(A * A);
    const B = mod(x2 - z2);
    const BB = mod(B * B);
    const E = mod(AA - BB);
    const C = mod(x3 + z3);
    const D = mod(x3 - z3);
    const DA = mod(D * A);
    const CB = mod(C * B);

    const daPlusCb = mod(DA + CB);
    const daMinusCb = mod(DA - CB);

    x3 = mod(daPlusCb * daPlusCb);
    z3 = mod(x1 * mod(daMinusCb * daMinusCb));
    x2 = mod(AA * BB);
    z2 = mod(E * mod(AA + mod(A24 * E)));
  }

  if (swap === 1n) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }

  const res = mod(x2 * modInv(z2));
  return encodeLittleEndian(res);
}

/**
 * Derive 32-byte X25519 public key from 32-byte private scalar.
 * @param {Uint8Array} privateKey
 * @returns {Uint8Array}
 */
export function x25519PublicKey(privateKey) {
  const basepoint = new Uint8Array(32);
  basepoint[0] = Number(BASEPOINT_U);
  return x25519(privateKey, basepoint);
}

/**
 * Reject all-zero low-order shared secret per RFC 7748 Section 6.1.
 * @param {Uint8Array} shared
 * @returns {boolean}
 */
export function isAllZeroBytes(shared) {
  let acc = 0;
  for (let i = 0; i < shared.length; i++) {
    acc |= shared[i];
  }
  return acc === 0;
}
