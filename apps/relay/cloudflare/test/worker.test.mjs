import test from "node:test";
import assert from "node:assert/strict";
import worker, { PiRelayHub, parseOuterStrict } from "../src/worker.mjs";

function createMockSocket() {
  const sent = [];
  let attachment = null;
  let closed = null;
  return {
    sent,
    get closed() {
      return closed;
    },
    send(msg) {
      if (closed) throw new Error("Socket closed");
      sent.push(msg);
    },
    close(code, reason) {
      closed = { code, reason };
    },
    serializeAttachment(v) {
      attachment = JSON.parse(JSON.stringify(v));
    },
    deserializeAttachment() {
      return attachment ? JSON.parse(JSON.stringify(attachment)) : null;
    },
  };
}

function createMockCtx() {
  const sockets = new Set();
  const kv = new Map();
  return {
    sockets,
    kv,
    acceptWebSocket(ws) {
      sockets.add(ws);
    },
    getWebSockets() {
      return Array.from(sockets).filter((s) => !s.closed);
    },
    storage: {
      async get(k) {
        return kv.get(k);
      },
      async put(k, v) {
        kv.set(k, v);
      },
    },
  };
}

test("parseOuterStrict rejects duplicate top-level keys", () => {
  assert.throws(() => parseOuterStrict('{"t":"cipher","t":"pair"}'), /Duplicate/);
  assert.deepEqual(parseOuterStrict('{"t":"ping","ts":123}'), { t: "ping", ts: 123 });
});

test("PiRelayHub handles host.register, takeover denial, client.join, pair/cipher forwarding, hibernation wakeup, and host.revoke", async () => {
  const ctx = createMockCtx();
  const hub1 = new PiRelayHub(ctx, {});

  const routeId = "rt_cf_test_route_0001";
  const secretHash = "a".repeat(64);
  const wrongHash = "b".repeat(64);

  const hostWs = createMockSocket();
  ctx.acceptWebSocket(hostWs);
  await hub1.webSocketMessage(
    hostWs,
    JSON.stringify({ t: "host.register", routeId, hostId: "host_1", hostSecretHash: secretHash })
  );
  assert.equal(JSON.parse(hostWs.sent.pop()).t, "host.registered");

  // Attacker with wrong hash cannot hijack route
  const attackerWs = createMockSocket();
  ctx.acceptWebSocket(attackerWs);
  await hub1.webSocketMessage(
    attackerWs,
    JSON.stringify({ t: "host.register", routeId, hostId: "evil", hostSecretHash: wrongHash })
  );
  assert.equal(JSON.parse(attackerWs.sent.pop()).code, "UNAUTHORIZED");

  // Mobile client joins
  const clientWs = createMockSocket();
  ctx.acceptWebSocket(clientWs);
  await hub1.webSocketMessage(clientWs, JSON.stringify({ t: "client.join", routeId, deviceId: "dev_1" }));
  assert.equal(JSON.parse(clientWs.sent.pop()).t, "client.joined");
  assert.equal(JSON.parse(hostWs.sent.pop()).t, "peer.joined");

  // Simulate Cloudflare Durable Object Hibernation wakeup: brand-new PiRelayHub instance, same ctx/storage/attachments!
  const hubAfterWake = new PiRelayHub(ctx, {});
  const rawPair = `{ "t": "pair", "routeId": "${routeId}", "deviceId": "dev_1", "payload": { "step": "pair.hello" } }`;
  await hubAfterWake.webSocketMessage(clientWs, rawPair);
  assert.equal(hostWs.sent.pop(), rawPair, "Pair frames must retain their original wire text");

  const rawCipher = '{"t":"cipher","routeId":"rt_cf_test_route_0001","deviceId":"dev_1","frameId":"f_1","envelope":{"ct":"abc=="}}';
  await hubAfterWake.webSocketMessage(clientWs, rawCipher);
  assert.equal(hostWs.sent.pop(), rawCipher, "Ciphertext must forward byte-for-byte after DO hibernation wakeup");

  // Healthz exposes only minimal liveness (no online client/route counts)
  const healthRes = await hubAfterWake.fetch(new Request("https://relay.example/healthz"));
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.ok, true);
  assert.equal(health.protocol, "pi-relay.v1");
  assert.equal("stats" in health, false, "Public /healthz must not expose online counts");

  // Non-relay routes (such as / or /app.mjs) return 404 (no public web frontend)
  for (const path of ["/", "/app.mjs"]) {
    const res = await worker.fetch(new Request(`https://relay.example${path}`), {});
    assert.equal(res.status, 404, path);
  }

  // Host revokes device
  await hubAfterWake.webSocketMessage(hostWs, JSON.stringify({ t: "host.revoke", routeId, deviceId: "dev_1" }));
  assert.equal(JSON.parse(clientWs.sent.pop()).code, "REVOKED");
  assert.equal(clientWs.closed?.code, 4003);
});
