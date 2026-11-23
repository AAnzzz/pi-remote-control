// QR Code Model 2, one Byte-mode segment. Coordinates here are (x, y) from top left.
// ISO/IEC 18004 Table 9, indexed by version - 1. All blocks have the same EC length;
// distributing the total codewords among them gives both group counts (short first).
const TOTAL_WORDS = [
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
  1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706,
];
const EC_WORDS = {
  L: [7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  M: [10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
  Q: [13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  H: [17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
};
const BLOCKS = {
  L: [1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
  M: [1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
  Q: [1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
  H: [1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81],
};
const EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

function dataWords(payload, version, capacity) {
  const data = new Uint8Array(capacity);
  let pos = 0;
  function append(value, width) {
    for (let i = width - 1; i >= 0; i--, pos++) {
      data[pos >>> 3] |= ((value >>> i) & 1) << (7 - (pos & 7));
    }
  }
  append(4, 4);
  append(payload.length, version < 10 ? 8 : 16);
  for (const byte of payload) append(byte, 8);
  // The buffer already contains the zero terminator and byte-boundary padding.
  pos = Math.min(pos + 4, capacity * 8);
  for (let i = Math.ceil(pos / 8), pad = 0xec; i < capacity; i++, pad ^= 0xec ^ 0x11) data[i] = pad;
  return data;
}

function gfMultiply(a, b) {
  let product = 0;
  while (b) {
    if (b & 1) product ^= a;
    a = (a << 1) ^ ((a & 0x80) ? 0x11d : 0);
    b >>>= 1;
  }
  return product;
}

function generatorPolynomial(degree) {
  let coefficients = [1]; // Descending powers; multiply by (x + alpha^i) at each step.
  let root = 1;
  for (let i = 0; i < degree; i++) {
    const next = [...coefficients, 0];
    coefficients.forEach((c, j) => { next[j + 1] ^= gfMultiply(c, root); });
    coefficients = next;
    root = gfMultiply(root, 2);
  }
  return coefficients;
}

function interleave(data, total, count, ecLength) {
  const shortLength = Math.floor(total / count) - ecLength;
  const shortCount = count - total % count;
  const divisor = generatorPolynomial(ecLength);
  const blocks = [], parity = [];
  let offset = 0;
  for (let b = 0; b < count; b++) {
    const length = shortLength + Number(b >= shortCount);
    const block = data.subarray(offset, offset + length);
    offset += length;
    const dividend = new Uint8Array(length + ecLength);
    dividend.set(block);
    for (let i = 0; i < length; i++) {
      const lead = dividend[i]; // Leading coefficient cancels; only update the trailing terms.
      for (let j = 1; j <= ecLength; j++) dividend[i + j] ^= gfMultiply(lead, divisor[j]);
    }
    blocks.push(block);
    parity.push(dividend.subarray(length));
  }
  const result = new Uint8Array(total);
  let out = 0;
  for (let i = 0; i <= shortLength; i++) {
    for (const block of blocks) if (i < block.length) result[out++] = block[i];
  }
  for (let i = 0; i < ecLength; i++) {
    for (const block of parity) result[out++] = block[i];
  }
  return result;
}

// Systematic binary polynomial code, MSB first.
function bch(value, degree, polynomial) {
  let remainder = value;
  for (let i = 0; i < degree; i++) {
    remainder <<= 1;
    if (remainder & (1 << degree)) remainder ^= polynomial;
  }
  return (value << degree) | remainder;
}

function drawFormat(size, level, mask, set) {
  const word = bch((EC_BITS[level] << 3) | mask, 10, 0x537) ^ 0x5412;
  const bit = i => (word >>> i) & 1;
  for (let i = 0; i < 6; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
}

function alignmentCenters(version, size) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  // Annex E spacing: anchor both ends, round the interior step up to even (V32 exception).
  const step = version === 32 ? 26 : 2 * Math.ceil((size - 13) / (2 * (count - 1)));
  return Array.from({ length: count }, (_, i) => i === 0 ? 6 : size - 7 - (count - 1 - i) * step);
}

function drawFunctions(version, size, level, set) {
  for (let i = 0; i < size; i++) {
    set(6, i, 1 - i % 2);
    set(i, 6, 1 - i % 2);
  }
  function square(cx, cy, radius, color) {
    for (let y = Math.max(0, cy - radius); y <= Math.min(size - 1, cy + radius); y++) {
      for (let x = Math.max(0, cx - radius); x <= Math.min(size - 1, cx + radius); x++) {
        set(x, y, Number(color(Math.max(Math.abs(x - cx), Math.abs(y - cy)))));
      }
    }
  }
  const finder = d => d !== 2 && d !== 4;
  square(3, 3, 4, finder);
  square(size - 4, 3, 4, finder);
  square(3, size - 4, 4, finder);
  const centers = alignmentCenters(version, size);
  for (const y of centers) for (const x of centers) {
    if ((x === 6 && (y === 6 || y === size - 7)) || (y === 6 && x === size - 7)) continue;
    square(x, y, 2, d => d !== 1);
  }
  set(8, size - 8, 1);
  drawFormat(size, level, 0, set); // Reserve both strips before placing data.
  if (version >= 7) {
    const word = bch(version, 12, 0x1f25);
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + i % 3, b = Math.floor(i / 3), bit = (word >>> i) & 1;
      set(a, b, bit);
      set(b, a, bit);
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  x => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

function linePenalty(matrix, start, stride, size) {
  // Alternating light/dark run lengths, always starting and ending with light.
  const runs = [0];
  let score = 0;
  for (let i = 0; i < size; i++) {
    if (matrix[start + i * stride] !== ((runs.length - 1) & 1)) runs.push(0);
    runs[runs.length - 1]++;
  }
  for (const length of runs) if (length >= 5) score += length - 2; // N1
  if (runs.length % 2 === 0) runs.push(0);
  // The light margin beyond the symbol counts for N3, but not for N1.
  runs[0] += size;
  runs[runs.length - 1] += size;
  for (let i = 1; i + 5 < runs.length; i += 2) {
    const n = runs[i];
    if (runs[i + 1] !== n || runs[i + 2] !== 3 * n || runs[i + 3] !== n || runs[i + 4] !== n) continue;
    const before = runs[i - 1], after = runs[i + 5];
    if (before >= 4 * n && after >= n) score += 40;
    if (after >= 4 * n && before >= n) score += 40;
  }
  return score;
}

function penalty(matrix, size) {
  let score = 0, dark = 0;
  for (let y = 0; y < size; y++) {
    score += linePenalty(matrix, y * size, 1, size) + linePenalty(matrix, y, size, size);
    for (let x = 0; x < size; x++) {
      const i = y * size + x, bit = matrix[i];
      dark += bit;
      if (x && y && matrix[i - 1] === bit && matrix[i - size] === bit && matrix[i - size - 1] === bit) score += 3; // N2
    }
  }
  return score + 10 * Math.floor(Math.abs(20 * dark - 10 * matrix.length) / matrix.length); // N4
}

function makeSymbol(version, ecLevel, words) {
  const size = version * 4 + 17;
  const base = new Uint8Array(size * size), reserved = new Uint8Array(base.length);
  drawFunctions(version, size, ecLevel, (x, y, bit) => {
    base[y * size + x] = bit;
    reserved[y * size + x] = 1;
  });
  let pos = 0, upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--; // Vertical timing column is never part of a pair.
    for (let row = 0; row < size; row++) {
      const y = upward ? size - 1 - row : row;
      for (let x = right; x >= right - 1; x--) {
        const i = y * size + x;
        if (reserved[i]) continue;
        if (pos < words.length * 8) base[i] = (words[pos >>> 3] >>> (7 - (pos & 7))) & 1;
        pos++; // Remaining modules start light; the mask applies to remainder bits too.
      }
    }
    upward = !upward;
  }
  let best, mask, lowest = Infinity;
  for (const [candidate, invert] of MASKS.entries()) {
    const matrix = base.slice();
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!reserved[i] && invert(x, y)) matrix[i] ^= 1;
    }
    drawFormat(size, ecLevel, candidate, (x, y, bit) => { matrix[y * size + x] = bit; });
    const score = penalty(matrix, size);
    if (score < lowest) { lowest = score; best = matrix; mask = candidate; }
  }
  const rows = Array.from({ length: size }, (_, y) => best.subarray(y * size, (y + 1) * size).join(""));
  return { version, ecLevel, size, mask, rows };
}

/** Encode UTF-8 bytes as a QR module matrix (no quiet zone). Only M can fall back to L. */
export function encodeQrCode(text, { ecLevel = "M" } = {}) {
  if (typeof text !== "string") throw new TypeError("QR text must be a string");
  if (typeof ecLevel !== "string" || !Object.hasOwn(EC_BITS, ecLevel)) throw new RangeError("QR ecLevel must be L, M, Q or H");
  // UTF-8 needs at least one byte per UTF-16 code unit. Reject oversized IPC input before allocating.
  const limitError = "QR text exceeds 2953 UTF-8 bytes";
  if (text.length > 2953) throw new RangeError(limitError);
  if (!text.isWellFormed()) throw new TypeError("QR text contains an unpaired surrogate");
  const payload = new TextEncoder().encode(text);
  if (payload.length > 2953) throw new RangeError(limitError);
  if (ecLevel === "M" && payload.length > 2331) ecLevel = "L";
  for (let i = 0; i < TOTAL_WORDS.length; i++) {
    const version = i + 1, total = TOTAL_WORDS[i];
    const count = BLOCKS[ecLevel][i], ecLength = EC_WORDS[ecLevel][i];
    const capacity = total - count * ecLength;
    if (4 + (version < 10 ? 8 : 16) + 8 * payload.length <= 8 * capacity) {
      const data = dataWords(payload, version, capacity);
      return makeSymbol(version, ecLevel, interleave(data, total, count, ecLength));
    }
  }
  throw new RangeError(`QR text exceeds byte capacity at EC level ${ecLevel}`);
}
