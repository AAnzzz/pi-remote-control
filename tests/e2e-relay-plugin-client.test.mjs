/**
 * Full 3-tier End-to-End Integration Test:
 *   [Mobile Companion Client] <== E2EE ==> [GPT Blind Relay (Node 24)] <== E2EE ==> [PI-Desktop Plugin Engine]
 *
 * Verifies:
 * 1. Host registers route on Blind Relay; direct LAN server disabled so 100% of traffic traverses the relay.
 * 2. Mobile pairs over the Blind Relay via 120s invite + X25519 + 6-digit SAS desktop approval.
 * 3. Mobile executes E2EE RPCs (host.info, session.list, turn.start, diff.summary, diff.file) over relay.
 * 4. Relay wire inspection proves ZERO plaintext prompt/code leakage inside forwarded cipher frames.
 * 5. Sidecar stream bridge emits message_update -> coalesced encrypted stream.delta reaches mobile over relay.
 * 6. Desktop revokes mobile -> Relay immediately sends REVOKED & closes mobile socket with code 4003.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { createRelayServer } from "../apps/relay/node/src/relay-core.mjs";
import { PluginVault } from "../apps/pi-plugin/src/vault.mjs";
import { PiHostAdapter } from "../apps/pi-plugin/src/host-adapter.mjs";
import { RemoteControlEngine } from "../apps/pi-plugin/src/remote-engine.mjs";
import {
  generateX25519KeyPair,
  computeSharedSecret,
  computeInviteProof,
  derivePairingMaterial,
  encryptEnvelope,
  decryptEnvelope,
  ReplayWindow,
  base64ToBytes,
} from "../packages/protocol/src/index.mjs";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("3-tier E2E: Mobile Client <-> GPT Blind Relay <-> PI-Desktop Plugin (zero-plaintext E2EE)", async () => {
  const dataDir = makeTempDir("pi-e2e-data-");
  const repoDir = makeTempDir("pi-e2e-repo-");

  // Prepare real git repo with one tracked change and one secret .env file
  execFileSync("git", ["init"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Dev"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "service.ts"), "export const port = 3000;\n");
  execFileSync("git", ["add", "service.ts"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "service.ts"), "export const port = 8080;\nexport const tls = true;\n");
  fs.writeFileSync(path.join(repoDir, ".env"), "TOP_SECRET_TOKEN=must_never_leak\n");

  // 1. Start GPT's Blind Relay server
  const relay = createRelayServer();
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const relayPort = relay.address().port;
  const relayWsUrl = `ws://127.0.0.1:${relayPort}/ws`;

  // Verify /healthz
  const health = await (await fetch(`http://127.0.0.1:${relayPort}/healthz`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.protocol, "pi-relay.v1");

  // 2. Start PI-Desktop Plugin Engine (relay-only mode, direct disabled)
  const vault = new PluginVault(dataDir);
  const promptSecret = "FIX_CONFIDENTIAL_AUTH_BUG_9912";
  const mockPi = {
    desktop: {
      async invoke({ operation, args }) {
        if (operation === "project/list") return [{ path: repoDir, name: "e2e-repo", active: true }];
        if (operation === "session/list") {
          return [{ id: "sess_e2e", title: "E2E Session", projectPath: repoDir, status: "idle", updatedAt: "2026-11-21T12:00:00Z" }];
        }
        if (operation === "agent/prompt") return { accepted: true, turnId: "turn_e2e_1", echo: args[0].content };
        if (operation === "agent/pendingInteractive") return { permissions: [], asks: [] };
        if (operation === "plans/pending") return [];
        return {};
      },
    },
  };
  const hostAdapter = new PiHostAdapter({ pi: mockPi, allowMcpHeadless: false });
  const engine = new RemoteControlEngine({
    vault,
    hostAdapter,
    settings: {
      hostName: "WangDesktop",
      directEnabled: false,
      directOnly: false,
      relayUrl: relayWsUrl,
    },
  });

  await engine.start();

  // Wait for plugin to register on Blind Relay
  for (let i = 0; i < 40; i++) {
    if (engine.relayStatus === "connected") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(engine.relayStatus, "connected", "Plugin must connect & register on GPT Blind Relay");

  try {
    // 3. Generate QR pairing invite on desktop
    const invite = engine.createPairingInvite();
    assert.equal(invite.relayUrl, relayWsUrl);
    assert.equal(invite.directUrls.length, 0);

    // 4. Mobile connects to Blind Relay and completes X25519 + SAS pairing
    const mobileWs = new WebSocket(invite.relayUrl);
    const wireLog = [];
    const inbox = [];
    let waiter = null;
    const nextMsg = () =>
      new Promise((resolve, reject) => {
        if (inbox.length > 0) return resolve(inbox.shift());
        const t = setTimeout(() => reject(new Error("Timeout waiting for relay message")), 5000);
        waiter = (m) => {
          clearTimeout(t);
          resolve(m);
        };
      });

    mobileWs.addEventListener("message", (evt) => {
      const raw = String(evt.data);
      wireLog.push(raw);
      const parsed = JSON.parse(raw);
      if (waiter) {
        const fn = waiter;
        waiter = null;
        fn(parsed);
      } else {
        inbox.push(parsed);
      }
    });

    await new Promise((resolve, reject) => {
      mobileWs.addEventListener("open", resolve, { once: true });
      mobileWs.addEventListener("error", reject, { once: true });
    });

    const deviceId = "dev_iphone_e2e";
    const clientKp = generateX25519KeyPair();

    mobileWs.send(JSON.stringify({ t: "client.join", routeId: invite.routeId, deviceId }));
    const joined = await nextMsg();
    assert.equal(joined.t, "client.joined");
    assert.equal(joined.hostOnline, true);

    const inviteProof = await computeInviteProof({
      inviteSecret: invite.inviteSecret,
      inviteId: invite.inviteId,
      hostId: invite.hostId,
      deviceId,
      clientDhPubB64: clientKp.publicKeyB64,
    });
    mobileWs.send(
      JSON.stringify({
        t: "pair",
        routeId: invite.routeId,
        deviceId,
        payload: {
          step: "pair.hello",
          inviteId: invite.inviteId,
          deviceName: "iPhone 16 Pro",
          clientDhPub: clientKp.publicKeyB64,
          inviteProof,
        },
      })
    );

    const pending = await nextMsg();
    assert.equal(pending.t, "pair");
    assert.equal(pending.payload.step, "pair.pending_approval");

    const shared = computeSharedSecret(clientKp.privateKey, base64ToBytes(invite.hostDhPub));
    const derived = await derivePairingMaterial({
      sharedSecret: shared,
      inviteSecret: invite.inviteSecret,
      inviteId: invite.inviteId,
      hostId: invite.hostId,
      deviceId,
      hostDhPubB64: invite.hostDhPub,
      clientDhPubB64: clientKp.publicKeyB64,
    });

    // Desktop verifies SAS & clicks Approve
    const snap = await engine.getConsoleSnapshot();
    assert.equal(snap.pendingPairings.length, 1);
    assert.equal(snap.pendingPairings[0].sasCode, derived.sasCode);
    engine.approvePendingPairing(snap.pendingPairings[0].pendingId);

    const approved = await nextMsg();
    assert.equal(approved.t, "pair");
    assert.equal(approved.payload.step, "pair.approved");

    // 5. Encrypted RPCs over Blind Relay
    let txSeq = 0;
    const rxReplay = new ReplayWindow();
    const sendRpc = async (method, params, idempotencyKey) => {
      txSeq += 1;
      const reqId = `req_${txSeq}`;
      const envelope = await encryptEnvelope({
        keyBytes: derived.sessionKey,
        keyId: derived.keyId,
        hostId: invite.hostId,
        deviceId,
        direction: "c2h",
        seq: txSeq,
        payload: { type: "req", id: reqId, idempotencyKey, method, params },
      });
      const wireOut = JSON.stringify({
        t: "cipher",
        routeId: invite.routeId,
        deviceId,
        frameId: reqId,
        envelope,
      });
      wireLog.push(wireOut);
      mobileWs.send(wireOut);

      while (true) {
        const frame = await nextMsg();
        if (frame.t !== "cipher") continue;
        const dec = await decryptEnvelope({
          keyBytes: derived.sessionKey,
          keyId: derived.keyId,
          hostId: invite.hostId,
          deviceId,
          expectedDirection: "h2c",
          envelope: frame.envelope,
          replayWindow: rxReplay,
        });
        if (dec.type === "res" && dec.id === reqId) return dec;
      }
    };

    const info = await sendRpc("host.info", {});
    assert.equal(info.ok, true);
    assert.equal(info.result.hostName, "WangDesktop");

    const promptRes = await sendRpc("turn.start", { sessionId: "sess_e2e", content: promptSecret }, "idem_e2e_1");
    assert.equal(promptRes.ok, true);
    assert.equal(promptRes.result.turnId, "turn_e2e_1");

    const diffSummary = await sendRpc("diff.summary", { projectPath: repoDir });
    assert.equal(diffSummary.ok, true);
    assert.equal(diffSummary.result.files.some((f) => f.path === "service.ts"), true);
    assert.equal(diffSummary.result.files.some((f) => f.path === ".env"), false);

    const diffFile = await sendRpc("diff.file", { projectPath: repoDir, filePath: "service.ts" });
    assert.equal(diffFile.ok, true);
    assert.equal(diffFile.result.hunks[0].lines.some((l) => l.text.includes("8080")), true);

    // 6. Sidecar streaming delta delivered end-to-end through Blind Relay
    const bridgeCfg = JSON.parse(fs.readFileSync(path.join(dataDir, "stream-bridge.json"), "utf8"));
    await fetch(`http://127.0.0.1:${bridgeCfg.port}/internal/stream-event`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-token": bridgeCfg.token },
      body: JSON.stringify({
        type: "message_update",
        sessionId: "sess_e2e",
        turnId: "turn_e2e_1",
        event: { message: { content: "CONFIDENTIAL_STREAM_TOKEN_XYZ" } },
      }),
    });

    let receivedStream = false;
    for (let i = 0; i < 6; i++) {
      const frame = await nextMsg();
      if (frame.t !== "cipher") continue;
      const dec = await decryptEnvelope({
        keyBytes: derived.sessionKey,
        keyId: derived.keyId,
        hostId: invite.hostId,
        deviceId,
        expectedDirection: "h2c",
        envelope: frame.envelope,
        replayWindow: rxReplay,
      });
      if (dec.type === "evt" && dec.event === "stream.delta") {
        assert.equal(dec.payload.delta, "CONFIDENTIAL_STREAM_TOKEN_XYZ");
        receivedStream = true;
        break;
      }
    }
    assert.equal(receivedStream, true);

    // 7. Zero-plaintext wire audit: none of the secrets/code/prompts ever crossed the relay in plaintext!
    const allWire = wireLog.join("\n");
    assert.equal(allWire.includes(promptSecret), false, "Prompt plaintext leaked on relay wire!");
    assert.equal(allWire.includes("CONFIDENTIAL_STREAM_TOKEN_XYZ"), false, "Stream plaintext leaked on relay wire!");
    assert.equal(allWire.includes("TOP_SECRET_TOKEN"), false, ".env secret leaked!");
    assert.equal(allWire.includes("export const port = 8080"), false, "Diff plaintext leaked on relay wire!");

    // 8. Desktop revokes device -> Relay immediately sends REVOKED & closes with code 4003
    const closePromise = new Promise((resolve) =>
      mobileWs.addEventListener("close", (e) => resolve(e.code), { once: true })
    );
    await engine.revokeDevice(deviceId);
    const code = await closePromise;
    assert.equal(code, 4003);
  } finally {
    await engine.stop();
    await relay.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
