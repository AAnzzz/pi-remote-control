import assert from "node:assert/strict";
import test from "node:test";
import {
  computeInviteProof, verifyInviteProof, derivePairingMaterial, encryptEnvelope, decryptEnvelope,
  generateX25519KeyPair, computeSharedSecret, ReplayWindow, utf8ToBytes, bytesToUtf8,
} from "@pi-remote/protocol";
import { createNobleWebCrypto, TextEncoderPolyfill, TextDecoderPolyfill } from "../src/lib/rnCryptoCore.mjs";
const native = globalThis.crypto;
const mobile = createNobleWebCrypto(native.getRandomValues.bind(native));
const host = generateX25519KeyPair(native);
const device = generateX25519KeyPair(mobile);
const invite = {
  hostId: "host-1", deviceId: "phone-1", inviteId: "invite-1",
  inviteSecret: native.getRandomValues(new Uint8Array(32)),
  clientDhPubB64: device.publicKeyB64, hostDhPubB64: host.publicKeyB64,
};

function corrupt(base64) {
  const bytes = Buffer.from(base64, "base64");
  bytes[0] ^= 1;
  return bytes.toString("base64");
}

test("SHA-256 matches native for a non-zero-offset BufferSource", async () => {
  const array = Uint8Array.of(0, 1, 2, 3, 4);
  const view = new DataView(array.buffer, 1, 3);
  assert.deepEqual(await mobile.subtle.digest("SHA-256", view), await native.subtle.digest("SHA-256", view));
});

test("invite proofs match byte for byte and cross-verify in both directions", async () => {
  const nativeProof = await computeInviteProof(invite, native);
  const mobileProof = await computeInviteProof(invite, mobile);
  assert.equal(mobileProof, nativeProof);
  for (const [impl, peerProof] of [[native, mobileProof], [mobile, nativeProof]]) {
    assert.equal(await verifyInviteProof(invite, peerProof, impl), true);
    assert.equal(await verifyInviteProof(invite, corrupt(peerProof), impl), false);
  }
});

async function pairingKeys() {
  const nativeMaterial = await derivePairingMaterial({ ...invite, sharedSecret: computeSharedSecret(host.privateKey, device.publicKey) }, native);
  const mobileMaterial = await derivePairingMaterial({ ...invite, sharedSecret: computeSharedSecret(device.privateKey, host.publicKey) }, mobile);
  return { nativeMaterial, mobileMaterial };
}

test("HKDF pairing key, encoded key, key ID and SAS match on both peers", async () => {
  const { nativeMaterial, mobileMaterial } = await pairingKeys();
  assert.deepEqual(mobileMaterial, nativeMaterial);
});

for (const direction of ["h2c", "c2h"]) {
  test(`${direction}: identical envelope bytes; cross-decrypt; reject modified ciphertext, tag and AAD`, async () => {
    const { nativeMaterial, mobileMaterial } = await pairingKeys();
    const nativeParams = { hostId: invite.hostId, deviceId: invite.deviceId, keyId: nativeMaterial.keyId, keyBytes: nativeMaterial.sessionKey };
    const mobileParams = { ...nativeParams, keyId: mobileMaterial.keyId, keyBytes: mobileMaterial.sessionKey };
    const payload = { type: "test", text: "Desktop ↔ 手机", nested: [false, 27] };
    const outgoing = { direction, payload, seq: 1 };

    // Reuse the native sender's IV ONLY for this identical-input comparison.
    const nativeEnvelope = await encryptEnvelope({ ...nativeParams, ...outgoing }, native);
    const sameIv = createNobleWebCrypto(view => view.set(Buffer.from(nativeEnvelope.iv, "base64")));
    assert.deepEqual(await encryptEnvelope({ ...mobileParams, ...outgoing }, sameIv), nativeEnvelope);
    const mobileEnvelope = await encryptEnvelope({ ...mobileParams, ...outgoing }, mobile);

    for (const [envelope, peer, params] of [[nativeEnvelope, mobile, mobileParams], [mobileEnvelope, native, nativeParams]]) {
      const replayWindow = new ReplayWindow();
      const open = candidate => decryptEnvelope({ ...params, expectedDirection: direction, envelope: candidate, replayWindow }, peer);
      await assert.rejects(open({ ...envelope, ct: corrupt(envelope.ct) }));
      await assert.rejects(open({ ...envelope, tag: corrupt(envelope.tag) }));
      await assert.rejects(open({ ...envelope, seq: 2 }));
      assert.deepEqual(await open(envelope), payload);
      await assert.rejects(open(envelope), /Replay/);
    }
  });
}

test("TextEncoderPolyfill & TextDecoderPolyfill match native UTF-8 byte-for-byte", () => {
  const nativeEnc = new TextEncoder();
  const nativeDec = new TextDecoder();
  const polyEnc = new TextEncoderPolyfill();
  const polyDec = new TextDecoderPolyfill();
  const samples = [
    "",
    "ASCII-only 0123456789 !@#",
    "中文测试：智能体 / 目标 / 规划 · 端到端加密",
    "Emoji 🚀🔐🛡️ surrogate pairs 𐐷 and mixed 汉字",
    "Lone surrogates: \uD800 middle \uDFFF end \uD83D",
  ];
  for (const s of samples) {
    const expected = nativeEnc.encode(s);
    const actual = polyEnc.encode(s);
    assert.deepEqual(actual, expected);
    assert.equal(polyDec.decode(actual), nativeDec.decode(expected));
  }
  const sub = new Uint8Array([0, ...nativeEnc.encode("hi你🚀"), 0]).subarray(1, -1);
  assert.equal(polyDec.decode(sub), "hi你🚀");
});

test("protocol utf8 helpers & envelope roundtrip work when global TextEncoder is absent (Hermes)", async () => {
  const savedTE = globalThis.TextEncoder;
  const savedTD = globalThis.TextDecoder;
  try {
    delete globalThis.TextEncoder;
    delete globalThis.TextDecoder;
    const text = "PI-Desktop 远程控制 🚀";
    const raw = utf8ToBytes(text);
    assert.equal(bytesToUtf8(raw), text);

    const { mobileMaterial } = await pairingKeys();
    const env = await encryptEnvelope(
      {
        hostId: invite.hostId,
        deviceId: invite.deviceId,
        keyId: mobileMaterial.keyId,
        keyBytes: mobileMaterial.sessionKey,
        direction: "c2h",
        seq: 1,
        payload: { msg: text },
      },
      mobile
    );
    const dec = await decryptEnvelope(
      {
        hostId: invite.hostId,
        deviceId: invite.deviceId,
        keyId: mobileMaterial.keyId,
        keyBytes: mobileMaterial.sessionKey,
        expectedDirection: "c2h",
        envelope: env,
        replayWindow: new ReplayWindow(),
      },
      mobile
    );
    assert.deepEqual(dec, { msg: text });
  } finally {
    globalThis.TextEncoder = savedTE;
    globalThis.TextDecoder = savedTD;
  }
});
