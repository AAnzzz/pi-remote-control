import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeQrCode } from "../src/qr-encoder.mjs";
import { onLoad, onPanelInvoke, onUnload } from "../main.js";
import { validatePairingInvite } from "../src/vendor/protocol/validators.mjs";

// Independent reader fixtures: ISO/IEC 18004 Table 9, one row per version,
// columns L M Q H, each group expressed as block count x data words per block.
// Parity length is inferred from the actual number of modules read from the matrix.
const GROUPS = `
1x19 1x16 1x13 1x9
1x34 1x28 1x22 1x16
1x55 1x44 2x17 2x13
1x80 2x32 2x24 4x9
1x108 2x43 2x15+2x16 2x11+2x12
2x68 4x27 4x19 4x15
2x78 4x31 2x14+4x15 4x13+1x14
2x97 2x38+2x39 4x18+2x19 4x14+2x15
2x116 3x36+2x37 4x16+4x17 4x12+4x13
2x68+2x69 4x43+1x44 6x19+2x20 6x15+2x16
4x81 1x50+4x51 4x22+4x23 3x12+8x13
2x92+2x93 6x36+2x37 4x20+6x21 7x14+4x15
4x107 8x37+1x38 8x20+4x21 12x11+4x12
3x115+1x116 4x40+5x41 11x16+5x17 11x12+5x13
5x87+1x88 5x41+5x42 5x24+7x25 11x12+7x13
5x98+1x99 7x45+3x46 15x19+2x20 3x15+13x16
1x107+5x108 10x46+1x47 1x22+15x23 2x14+17x15
5x120+1x121 9x43+4x44 17x22+1x23 2x14+19x15
3x113+4x114 3x44+11x45 17x21+4x22 9x13+16x14
3x107+5x108 3x41+13x42 15x24+5x25 15x15+10x16
4x116+4x117 17x42 17x22+6x23 19x16+6x17
2x111+7x112 17x46 7x24+16x25 34x13
4x121+5x122 4x47+14x48 11x24+14x25 16x15+14x16
6x117+4x118 6x45+14x46 11x24+16x25 30x16+2x17
8x106+4x107 8x47+13x48 7x24+22x25 22x15+13x16
10x114+2x115 19x46+4x47 28x22+6x23 33x16+4x17
8x122+4x123 22x45+3x46 8x23+26x24 12x15+28x16
3x117+10x118 3x45+23x46 4x24+31x25 11x15+31x16
7x116+7x117 21x45+7x46 1x23+37x24 19x15+26x16
5x115+10x116 19x47+10x48 15x24+25x25 23x15+25x16
13x115+3x116 2x46+29x47 42x24+1x25 23x15+28x16
17x115 10x46+23x47 10x24+35x25 19x15+35x16
17x115+1x116 14x46+21x47 29x24+19x25 11x15+46x16
13x115+6x116 14x46+23x47 44x24+7x25 59x16+1x17
12x121+7x122 12x47+26x48 39x24+14x25 22x15+41x16
6x121+14x122 6x47+34x48 46x24+10x25 2x15+64x16
17x122+4x123 29x46+14x47 49x24+10x25 24x15+46x16
4x122+18x123 13x46+32x47 48x24+14x25 42x15+32x16
20x117+4x118 40x47+7x48 43x24+22x25 10x15+67x16
19x118+6x119 18x47+31x48 34x24+34x25 20x15+61x16
`.trim().split("\n").map(row => row.split(" "));

function dataLengths(version, level) {
  return GROUPS[version - 1]["LMQH".indexOf(level)].split("+").flatMap(group => {
    const [count, length] = group.split("x").map(Number);
    return Array(count).fill(length);
  });
}

// Annex E, intermediate alignment centers only (the two outer centers are 6 and size-7).
const INTERIOR = [
  [], [], [], [], [], [], [22], [24], [26], [28], [30], [32], [34],
  [26,46], [26,48], [26,50], [30,54], [30,56], [30,58], [34,62],
  [28,50,72], [26,50,74], [30,54,78], [28,54,80], [32,58,84], [30,58,86], [34,62,90],
  [26,50,74,98], [30,54,78,102], [26,52,78,104], [30,56,82,108], [34,60,86,112], [30,58,86,114], [34,62,90,118],
  [30,54,78,102,126], [24,50,76,102,128], [28,54,80,106,132], [32,58,84,110,136], [26,54,82,110,138], [30,58,86,114,142],
];

function binaryRemainder(value, divisor) {
  while (value && Math.clz32(value) <= Math.clz32(divisor)) {
    value ^= divisor << (Math.clz32(divisor) - Math.clz32(value));
  }
  return value;
}

function inspectFunctions(rows, version) {
  const size = rows.length;
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));
  function read(r, c) {
    reserved[r][c] = 1;
    return rows[r][c];
  }
  const finder = ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"];
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = Math.max(0, top - 1); r < Math.min(size, top + 8); r++) {
      for (let c = Math.max(0, left - 1); c < Math.min(size, left + 8); c++) {
        assert.equal(read(r, c), finder[r - top]?.[c - left] ?? "0", "finder or separator");
      }
    }
  }
  const alignment = ["11111", "10001", "10101", "10001", "11111"];
  const centers = version === 1 ? [] : [6, ...INTERIOR[version - 1], size - 7];
  for (const r of centers) for (const c of centers) {
    if (reserved[r][c]) continue; // Already in a finder.
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
      assert.equal(read(r + y - 2, c + x - 2), alignment[y][x], "alignment");
    }
  }
  for (let i = 8; i < size - 8; i++) {
    assert.equal(read(6, i), i % 2 ? "0" : "1", "horizontal timing");
    assert.equal(read(i, 6), i % 2 ? "0" : "1", "vertical timing");
  }
  assert.equal(read(size - 8, 8), "1", "fixed dark module");
  if (version >= 7) {
    let upper = "", lower = "";
    for (let i = 5; i >= 0; i--) for (let j = size - 9; j >= size - 11; j--) {
      upper += read(i, j);
      lower += read(j, i);
    }
    assert.equal(upper, lower, "both version copies");
    const word = parseInt(upper, 2);
    assert.equal(word >>> 12, version);
    assert.equal(binaryRemainder(word, 0x1f25), 0, "version BCH syndrome");
  }
  let first = "", second = "";
  for (const c of [0, 1, 2, 3, 4, 5, 7, 8]) first += read(8, c);
  for (const r of [7, 5, 4, 3, 2, 1, 0]) first += read(r, 8);
  for (let r = size - 1; r >= size - 7; r--) second += read(r, 8);
  for (let c = size - 8; c < size; c++) second += read(8, c);
  assert.equal(first, second, "both format copies");
  const word = parseInt(first, 2) ^ 0x5412;
  assert.equal(binaryRemainder(word, 0x537), 0, "format BCH syndrome");
  return { reserved, mask: (word >>> 10) & 7, ecLevel: "MLHQ"[word >>> 13] };
}

// The mask tiles repeat every six rows and columns (four rows for mask 4).
function inverted(mask, r, c) {
  const product = r * c;
  switch (mask) {
    case 0: return !((r ^ c) & 1);
    case 1: return !(r & 1);
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return !(((r >> 1) ^ Math.floor(c / 3)) & 1);
    case 5: return product % 6 === 0;
    case 6: return [0, 1, 2].includes(product % 6);
    case 7: return ((product % 3) & 1) === ((r + c) & 1);
  }
}

function extractBits(rows, reserved, mask) {
  const n = rows.length, bits = [];
  const columns = Array.from({ length: n }, (_, i) => n - 1 - i).filter(c => c !== 6);
  for (let stripe = 0; stripe < columns.length / 2; stripe++) {
    for (let i = 0; i < n; i++) {
      const r = stripe % 2 ? i : n - 1 - i;
      for (const c of [columns[stripe * 2], columns[stripe * 2 + 1]]) {
        if (!reserved[r][c]) bits.push(Number(rows[r][c]) ^ Number(inverted(mask, r, c)));
      }
    }
  }
  return bits;
}

// Check the received polynomial at every generator root using log arithmetic and
// Horner's rule. No encoder polynomial generator, division or GF multiplication is reused.
const exp = [], log = [];
for (let i = 0, x = 1; i < 255; i++) {
  exp[i] = x;
  log[x] = i;
  x *= 2;
  if (x >= 256) x ^= 285;
}
function recoverData(words, lengths) {
  const dataCount = lengths.reduce((a, b) => a + b);
  const ecLength = (words.length - dataCount) / lengths.length;
  assert.ok(Number.isInteger(ecLength) && ecLength >= 7 && ecLength <= 30);
  const blocks = lengths.map(() => []);
  let p = 0;
  for (let column = 0; p < dataCount; column++) {
    lengths.forEach((length, i) => { if (column < length) blocks[i].push(words[p++]); });
  }
  const data = blocks.flat();
  for (let column = 0; column < ecLength; column++) for (const block of blocks) block.push(words[p++]);
  assert.equal(p, words.length);
  for (const [b, block] of blocks.entries()) {
    for (let root = 0; root < ecLength; root++) {
      let syndrome = 0;
      for (const byte of block) syndrome = byte ^ (syndrome ? exp[(log[syndrome] + root) % 255] : 0);
      assert.equal(syndrome, 0, `RS syndrome: block ${b}, root ${root}`);
    }
  }
  return data;
}

// Decode from rows alone; reported metadata is checked separately by the caller.
function decode(rows) {
  const version = (rows.length - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1 && version <= 40);
  for (const row of rows) {
    assert.equal(row.length, rows.length);
    assert.match(row, /^[01]+$/);
  }
  const { reserved, mask, ecLevel } = inspectFunctions(rows, version);
  const bits = extractBits(rows, reserved, mask);
  const remainder = version === 1 || (version >= 7 && version <= 13) || version >= 35 ? 0
    : version <= 6 ? 7 : version >= 21 && version <= 27 ? 4 : 3;
  assert.equal(bits.length % 8, remainder, "remainder bit count");
  assert.ok(bits.splice(bits.length - remainder).every(bit => bit === 0), "unmasked remainder bits");
  const words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  const data = recoverData(words, dataLengths(version, ecLevel));
  const stream = data.map(word => word.toString(2).padStart(8, "0")).join("");
  let pos = 0;
  function take(length) {
    assert.ok(pos + length <= stream.length, "truncated byte segment");
    const part = stream.slice(pos, pos + length);
    pos += length;
    return parseInt(part, 2);
  }
  assert.equal(take(4), 4, "byte mode");
  const length = take(version < 10 ? 8 : 16);
  const bytes = Uint8Array.from({ length }, () => take(8));
  assert.equal(take(4), 0, "terminator");
  for (let i = 0; pos < stream.length; i++) assert.equal(take(8), i % 2 ? 0x11 : 0xec, "pad word");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return { text, bytes, version, mask, ecLevel };
}

function check(qr, text) {
  const result = decode(qr.rows);
  assert.equal(result.version, qr.version);
  assert.equal(result.mask, qr.mask);
  assert.equal(result.ecLevel, qr.ecLevel);
  assert.equal(qr.size, qr.rows.length);
  assert.deepEqual(Buffer.from(result.bytes), Buffer.from(text, "utf8"));
  assert.equal(result.text, text);
}

// OpenCV 5 QRCodeEncoder, version=1, MODE_BYTE, CORRECT_LEVEL_M; margin removed.
const HELLO = `111111101100101111111
100000100001001000001
101110100101001011101
101110101001001011101
101110101110101011101
100000101001001000001
111111101010101111111
000000001001100000000
100010111111011111001
000100001011100001111
001111110011011010010
111110001100010000000
111110101010101100110
000000001010111101011
111111101110101011010
100000100101110110011
101110101101011000110
101110100100100011011
101110100111000111000
100000100001010000000
111111101111111110101`.split("\n");

test("V1-M HELLO WORLD matches an independent matrix exactly and decodes", () => {
  const qr = encodeQrCode("HELLO WORLD");
  assert.deepEqual(qr, { version: 1, size: 21, ecLevel: "M", mask: 4, rows: HELLO });
  check(qr, "HELLO WORLD");
});

test("reader detects corruption of a single transmitted bit", () => {
  const rows = HELLO.slice();
  rows[20] = rows[20].slice(0, 19) + (rows[20][19] === "1" ? "0" : "1") + rows[20][20];
  assert.throws(() => decode(rows), /RS syndrome/);
});

test("all eight masks can win, and equal penalties select the lowest mask", () => {
  // Fixed V1-M byte-mode vectors: independently score all eight completed matrices.
  // For pair:91, masks 2 and 4 both score 1075 (the minimum).
  const winners = [[2, 0], [87, 1], [0, 2], [3, 3], [11, 4], [22, 5], [74, 6], [103, 7], [91, 2]];
  for (const [suffix, mask] of winners) {
    const text = `pair:${suffix}`;
    const qr = encodeQrCode(text);
    assert.equal(qr.mask, mask, text);
    check(qr, text);
  }
});

function sample(length, seed) {
  let text = "";
  while (text.length < length) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    text += String.fromCharCode(32 + (seed >>> 16) % 95);
  }
  return text;
}

for (const level of "LMQH") {
  test(`all 40 versions at ${level}: exact byte capacity, every block and payload`, () => {
    for (let version = 1; version <= 40; version++) {
      const capacity = dataLengths(version, level).reduce((a, b) => a + b) - (version < 10 ? 2 : 3);
      const text = sample(capacity, version);
      const qr = encodeQrCode(text, { ecLevel: level });
      assert.equal(qr.version, version, `capacity ${capacity} at ${level}`);
      assert.equal(qr.ecLevel, level);
      check(qr, text);
    }
  });
}

test("UTF-8 byte boundaries, byte-mode padding, large symbols and M fallback", () => {
  for (const [text, version, level] of [
    ["", 1, "M"], ["\ufeff\0e\u0301😀", 1, "M"], ["中".repeat(5), 2, "M"],
    ["a".repeat(180), 9, "M"], ["a".repeat(181), 10, "M"],
    ["界".repeat(500), 32, "M"], ["a".repeat(2331), 40, "M"],
    ["界".repeat(777) + "a", 36, "L"], ["界".repeat(984) + "a", 40, "L"],
  ]) {
    const qr = encodeQrCode(text);
    assert.equal(qr.version, version);
    assert.equal(qr.ecLevel, level);
    check(qr, text);
  }
});

test("rejects invalid texts, levels, and oversized UTF-8 without silently weakening Q/H", () => {
  for (const value of [null, 7, {}, undefined]) assert.throws(() => encodeQrCode(value), TypeError);
  for (const ecLevel of ["", "m", "toString", ["H"], null]) assert.throws(() => encodeQrCode("", { ecLevel }), /ecLevel/);
  assert.throws(() => encodeQrCode("\ud800"), /surrogate/);
  assert.throws(() => encodeQrCode("a".repeat(2954)), /2953/);
  assert.throws(() => encodeQrCode("界".repeat(985)), /2953/);
  for (const [ecLevel, length] of [["Q", 1664], ["H", 1274]]) {
    assert.throws(() => encodeQrCode("a".repeat(length), { ecLevel }), /capacity/);
  }
});

test("420-byte multilingual PairingInvite JSON round-trips as V16-M", () => {
  const invite = {
    v: 1, hostId: "host_0123456789abcdef", hostName: "研发主机-Lab1",
    hostDhPub: "A".repeat(43) + "=", inviteId: "inv_abcdefghijklm", inviteSecret: "B".repeat(43) + "=",
    directUrls: ["ws://192.168.1.20:8787/ws", "ws://10.0.0.20:8787/ws", "ws://100.64.0.20:8787/ws"],
    relayUrl: "wss://relay.example.test/ws", routeId: "route_0123456789abcdef", expiresAt: 1893456000000,
  };
  assert.deepEqual(validatePairingInvite(invite, invite.expiresAt - 1000), { ok: true });
  const json = JSON.stringify(invite);
  assert.equal(Buffer.byteLength(json), 420);
  const qr = encodeQrCode(json);
  assert.equal(qr.version, 16);
  assert.equal(qr.size, 81);
  assert.equal(qr.ecLevel, "M");
  check(qr, json);
});

test("panel IPC returns a valid invite and decodable JSON, enforces UTF-8 bounds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qr-"));
  try {
    await onLoad({
      plugin: { getDataPath: () => dir, getSettings: () => ({ directEnabled: false, hostName: "测试主机" }) },
      services: { register() {} }, // Binding the panel does not need a listening service.
    });
    const legacy = await onPanelInvoke("remote.pair.create");
    assert.deepEqual(validatePairingInvite(legacy), { ok: true });
    const { invite, inviteJson, qr } = await onPanelInvoke("remote.pair.createWithQr");
    assert.deepEqual(validatePairingInvite(invite), { ok: true });
    assert.deepEqual(JSON.parse(inviteJson), invite);
    assert.equal(inviteJson, JSON.stringify(invite));
    check(JSON.parse(JSON.stringify(qr)), inviteJson);
    const encoded = await onPanelInvoke("remote.qr.encode", { text: "扫码", ecLevel: "H" });
    assert.equal(encoded.ecLevel, "H");
    check(encoded, "扫码");
    await assert.rejects(onPanelInvoke("remote.qr.encode", { text: "界".repeat(985) }), /2953/);
    await assert.rejects(onPanelInvoke("remote.qr.encode"), /string/);
  } finally {
    await onUnload();
    rmSync(dir, { recursive: true, force: true });
  }
});
