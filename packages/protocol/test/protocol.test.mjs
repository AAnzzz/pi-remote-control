import test from "node:test";
import assert from "node:assert/strict";
import {
  x25519,
  x25519PublicKey,
  hexToBytes,
  bytesToHex,
  generateX25519KeyPair,
  computeSharedSecret,
  computeInviteProof,
  verifyInviteProof,
  derivePairingMaterial,
  encryptEnvelope,
  decryptEnvelope,
  ReplayWindow,
  validatePairingInvite,
  validateRpcRequest,
  isDeniedCredentialPath,
  isAllowedWsUrl,
  redactSecrets,
  EventCursorLog,
  StreamDeltaCoalescer,
  IdempotencyStore,
  randomBytes,
  bytesToBase64,
} from "../src/index.mjs";

test("X25519 matches RFC 7748 Section 6.1 official test vectors", () => {
  const alicePriv = hexToBytes("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
  const alicePubExpected = "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a";
  const bobPriv = hexToBytes("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
  const bobPubExpected = "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f";
  const sharedExpected = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";

  const alicePub = x25519PublicKey(alicePriv);
  const bobPub = x25519PublicKey(bobPriv);
  assert.equal(bytesToHex(alicePub), alicePubExpected);
  assert.equal(bytesToHex(bobPub), bobPubExpected);

  const sharedA = x25519(alicePriv, bobPub);
  const sharedB = x25519(bobPriv, alicePub);
  assert.equal(bytesToHex(sharedA), sharedExpected);
  assert.equal(bytesToHex(sharedB), sharedExpected);
});

test("X25519 rejects low-order all-zero public key", () => {
  const kp = generateX25519KeyPair();
  assert.throws(() => computeSharedSecret(kp.privateKey, new Uint8Array(32)), /all-zero/);
});

test("Pairing proof, SAS derivation, E2EE encryption, anti-tamper, anti-reflection, anti-replay", async () => {
  const hostKp = generateX25519KeyPair();
  const clientKp = generateX25519KeyPair();
  const inviteSecret = bytesToBase64(randomBytes(32));
  const inviteId = "inv_001";
  const hostId = "host_desktop_1";
  const deviceId = "dev_iphone_1";

  const proof = await computeInviteProof({
    inviteSecret,
    inviteId,
    hostId,
    deviceId,
    clientDhPubB64: clientKp.publicKeyB64,
  });

  assert.equal(
    await verifyInviteProof(
      { inviteSecret, inviteId, hostId, deviceId, clientDhPubB64: clientKp.publicKeyB64 },
      proof
    ),
    true
  );
  assert.equal(
    await verifyInviteProof(
      { inviteSecret, inviteId, hostId, deviceId: "dev_attacker", clientDhPubB64: clientKp.publicKeyB64 },
      proof
    ),
    false
  );

  const sharedHost = computeSharedSecret(hostKp.privateKey, clientKp.publicKey);
  const sharedClient = computeSharedSecret(clientKp.privateKey, hostKp.publicKey);

  const hostMat = await derivePairingMaterial({
    sharedSecret: sharedHost,
    inviteSecret,
    inviteId,
    hostId,
    deviceId,
    hostDhPubB64: hostKp.publicKeyB64,
    clientDhPubB64: clientKp.publicKeyB64,
  });
  const clientMat = await derivePairingMaterial({
    sharedSecret: sharedClient,
    inviteSecret,
    inviteId,
    hostId,
    deviceId,
    hostDhPubB64: hostKp.publicKeyB64,
    clientDhPubB64: clientKp.publicKeyB64,
  });

  assert.equal(hostMat.sasCode, clientMat.sasCode);
  assert.match(hostMat.sasCode, /^\d{6}$/);
  assert.equal(hostMat.sessionKeyB64, clientMat.sessionKeyB64);
  assert.equal(hostMat.keyId, clientMat.keyId);

  const hostReplay = new ReplayWindow();
  const envelope = await encryptEnvelope({
    keyBytes: clientMat.sessionKey,
    keyId: clientMat.keyId,
    hostId,
    deviceId,
    direction: "c2h",
    seq: 1,
    payload: { type: "req", id: "r1", method: "turn.start", params: { prompt: "fix tests" } },
  });

  const decoded = await decryptEnvelope({
    keyBytes: hostMat.sessionKey,
    keyId: hostMat.keyId,
    hostId,
    deviceId,
    expectedDirection: "c2h",
    envelope,
    replayWindow: hostReplay,
  });
  assert.equal(decoded.method, "turn.start");

  // Replay of seq=1 must fail
  await assert.rejects(
    () =>
      decryptEnvelope({
        keyBytes: hostMat.sessionKey,
        keyId: hostMat.keyId,
        hostId,
        deviceId,
        expectedDirection: "c2h",
        envelope,
        replayWindow: hostReplay,
      }),
    /Replay detected/
  );

  // Direction reflection must fail
  await assert.rejects(
    () =>
      decryptEnvelope({
        keyBytes: hostMat.sessionKey,
        keyId: hostMat.keyId,
        hostId,
        deviceId,
        expectedDirection: "h2c",
        envelope,
      }),
    /Direction mismatch/
  );

  // Tampered ciphertext must fail authentication and NOT consume seq in replay window
  const env2 = await encryptEnvelope({
    keyBytes: clientMat.sessionKey,
    keyId: clientMat.keyId,
    hostId,
    deviceId,
    direction: "c2h",
    seq: 2,
    payload: { hello: "world" },
  });
  const tampered = { ...env2, ct: bytesToBase64(new Uint8Array([1, 2, 3, 4])) };
  await assert.rejects(() =>
    decryptEnvelope({
      keyBytes: hostMat.sessionKey,
      keyId: hostMat.keyId,
      hostId,
      deviceId,
      expectedDirection: "c2h",
      envelope: tampered,
      replayWindow: hostReplay,
    })
  );
  // Legitimate seq=2 should still be accepted after tampered packet was rejected
  const ok2 = await decryptEnvelope({
    keyBytes: hostMat.sessionKey,
    keyId: hostMat.keyId,
    hostId,
    deviceId,
    expectedDirection: "c2h",
    envelope: env2,
    replayWindow: hostReplay,
  });
  assert.equal(ok2.hello, "world");
});

test("Validators block credential paths, traversal, insecure URLs, expired invites, and redact secrets", () => {
  assert.equal(isDeniedCredentialPath(".env"), true);
  assert.equal(isDeniedCredentialPath("sub/.env.local"), true);
  assert.equal(isDeniedCredentialPath(".ssh/id_rsa"), true);
  assert.equal(isDeniedCredentialPath("certs/server.pem"), true);
  assert.equal(isDeniedCredentialPath("../outside.ts"), true);
  assert.equal(isDeniedCredentialPath(".git/config"), true);
  assert.equal(isDeniedCredentialPath("src/index.ts"), false);

  assert.equal(isAllowedWsUrl("wss://relay.example.com/ws", false), true);
  assert.equal(isAllowedWsUrl("ws://relay.example.com/ws", true), false);
  assert.equal(isAllowedWsUrl("ws://192.168.1.25:47921/ws", true), true);
  assert.equal(isAllowedWsUrl("ws://100.88.12.3:47921/ws", true), true);
  assert.equal(isAllowedWsUrl("wss://user:pass@relay.example.com/ws", true), false);

  const expired = validatePairingInvite({
    v: 1,
    hostId: "host-1",
    hostName: "PC",
    inviteId: "inv-1",
    inviteSecret: "abc",
    hostDhPub: "def",
    expiresAt: Date.now() - 1000,
  });
  assert.equal(expired.ok, false);

  assert.equal(validateRpcRequest({ type: "req", id: "1", method: "turn.start", params: {} }).ok, true);
  assert.equal(validateRpcRequest({ type: "req", id: "1", method: "shell.exec", params: {} }).ok, false);

  const redacted = redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdef and sk-1234567890abcdef1234");
  assert.equal(redacted.includes("eyJhbG"), false);
  assert.equal(redacted.includes("sk-1234"), false);
});

test("EventCursorLog pull, eviction snapshot fallback, StreamDeltaCoalescer, and IdempotencyStore", async () => {
  const log = new EventCursorLog({ epoch: "ep-A", maxEvents: 3 });
  log.append("turn.state", { status: "running" }, "s1");
  log.append("message.final", { text: "a" }, "s1");
  log.append("message.final", { text: "b" }, "s1");
  log.append("turn.state", { status: "idle" }, "s1");

  // seq=1 evicted, so afterSeq=0 needs snapshot
  assert.equal(log.pull({ epoch: "ep-A", afterSeq: 0 }).needsSnapshot, true);
  // wrong epoch needs snapshot
  assert.equal(log.pull({ epoch: "ep-OLD", afterSeq: 2 }).needsSnapshot, true);
  // valid cursor pulls delta events 3 and 4
  const pulled = log.pull({ epoch: "ep-A", afterSeq: 2 });
  assert.equal(pulled.needsSnapshot, false);
  assert.deepEqual(
    pulled.events.map((e) => e.seq),
    [3, 4]
  );

  // Coalescer merges rapid chunks
  const flushed = [];
  const coalescer = new StreamDeltaCoalescer({
    flushIntervalMs: 30,
    maxChunkBytes: 100,
    onFlush: (c) => flushed.push(c),
  });
  coalescer.push({ sessionId: "s1", turnId: "t1", delta: "Hel" });
  coalescer.push({ sessionId: "s1", turnId: "t1", delta: "lo!" });
  coalescer.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].delta, "Hello!");
  coalescer.dispose();

  // IdempotencyStore deduplicates same payload and rejects conflicting payload
  const idem = new IdempotencyStore();
  let runs = 0;
  const r1 = await idem.checkOrRun({
    deviceId: "d1",
    idempotencyKey: "cmd-1",
    method: "turn.start",
    params: { content: "hi" },
    execute: async () => ({ turnId: `t-${++runs}` }),
  });
  const r2 = await idem.checkOrRun({
    deviceId: "d1",
    idempotencyKey: "cmd-1",
    method: "turn.start",
    params: { content: "hi" },
    execute: async () => ({ turnId: `t-${++runs}` }),
  });
  assert.equal(runs, 1);
  assert.equal(r1.replayed, false);
  assert.equal(r2.replayed, true);
  assert.equal(r2.result.turnId, "t-1");

  await assert.rejects(
    () =>
      idem.checkOrRun({
        deviceId: "d1",
        idempotencyKey: "cmd-1",
        method: "turn.start",
        params: { content: "different" },
        execute: async () => ({ turnId: "t-bad" }),
      }),
    (err) => err.code === "IDEMPOTENCY_CONFLICT"
  );
});
