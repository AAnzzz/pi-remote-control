import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { createRelayServer } from '../src/relay-core.mjs';

const routeId = 'example_route-0123456789', secret = 'host-test-secret';
const hostSecretHash = createHash('sha256').update(secret).digest('hex');
const register = { t: 'host.register', hostId: 'host-1', hostSecretHash, routeId };
const join = deviceId => ({ t: 'client.join', routeId, deviceId });
const cipher = (deviceId, ct = 'abc==') => ({ t: 'cipher', routeId, deviceId, frameId: 'frame-1', envelope: { v: 1, alg: 'X25519-HKDF-SHA256-AES256GCM', iv: '123', ct, tag: 'xyz', seq: 7 } });
const pair = (deviceId, payload) => ({ t: 'pair', routeId, deviceId, payload });
const run = (name, fn) => test(name, { timeout: 8000 }, fn);

async function fixture(t, options = {}) {
  const server = createRelayServer(options); server.listen(0, '127.0.0.1');
  await once(server, 'listening'); t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data, key = secret) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-route-id': routeId, 'x-host-secret': key }, body: data === undefined ? undefined : JSON.stringify(data) });
  async function socket() {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', 'pi-relay.v1');
    const closed = once(ws, 'close').then(([e]) => e);
    const queue = [], wait = [];
    ws.addEventListener('message', e => { if (wait.length) wait.shift()(e.data); else queue.push(e.data); });
    const raw = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => wait.push(resolve));
    await once(ws, 'open'); assert.equal(ws.protocol, 'pi-relay.v1');
    return { ws, raw, closed, send: m => ws.send(typeof m === 'string' ? m : JSON.stringify(m)), read: async () => JSON.parse(await raw()) };
  }
  async function host() {
    const h = await socket(); h.send(register);
    assert.deepEqual(await h.read(), { t: 'host.registered', routeId, maxFrameBytes: options.maxFrameBytes ?? 262144, heartbeatMs: options.heartbeatMs ?? 25000 }); return h;
  }
  async function client(h, deviceId, token) {
    const c = await socket(); c.send({ ...join(deviceId), joinToken: token });
    const fields = { routeId, deviceId, hostOnline: true };
    assert.deepEqual(await c.read(), { t: 'client.joined', ...fields });
    assert.deepEqual(await h.read(), { t: 'peer.joined', ...fields }); return c;
  }
  return { base, server, post, socket, host, client, health: () => fetch(base + '/healthz').then(r => r.json()) };
}

run('healthz exposes only version, protocol and online counts', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.health(), { ok: true, version: '1.0.0', protocol: 'pi-relay.v1', stats: { routes: 0, clients: 0 } });
  const h = await f.host(), c = await f.client(h, 'd1');
  assert.deepEqual((await f.health()).stats, { routes: 1, clients: 1 });
  c.ws.close(); assert.deepEqual(await h.read(), { t: 'peer.left', deviceId: 'd1', routeId, role: 'client' });
});

run('invalid registration and takeover denied; same credential replaces without losing clients', async t => {
  const f = await fixture(t), h = await f.host(), c = await f.client(h, 'd1'), next = await f.socket();
  for (const change of [{ routeId: 'short' }, { routeId: 'a'.repeat(129) }, { hostSecretHash: 'g'.repeat(64) }]) {
    next.send({ ...register, ...change }); assert.equal((await next.read()).code, 'BAD_FRAME');
  }
  next.send({ ...register, hostSecretHash: '0'.repeat(64) }); assert.equal((await next.read()).code, 'UNAUTHORIZED');
  next.send({ ...register, hostSecretHash: hostSecretHash.toUpperCase() }); assert.equal((await next.read()).t, 'host.registered');
  assert.equal((await h.closed).code, 4001); assert.equal((await c.read()).t, 'peer.left'); assert.equal((await c.read()).role, 'host');
  assert.equal((await next.read()).deviceId, 'd1'); c.send(cipher('d1')); assert.deepEqual(await next.read(), cipher('d1'));
  next.ws.close(); assert.deepEqual(await c.read(), { t: 'peer.left', routeId, role: 'host' });
  const other = await f.socket(); other.send(join('d2')); assert.equal((await other.read()).code, 'ROUTE_NOT_FOUND');
  other.send({ ...register, hostSecretHash: '0'.repeat(64) }); assert.equal((await other.read()).code, 'UNAUTHORIZED');
});

run('pair and cipher pass byte-for-byte in both directions, including 16/64-bit payload lengths', async t => {
  const f = await fixture(t), h = await f.host(), c = await f.client(h, 'mobile');
  for (const [a, b, m] of [[c, h, pair('mobile', { t: 'pair.hello' })], [h, c, pair('mobile', { t: 'pair.approved' })], [c, h, cipher('mobile', 'x'.repeat(1024))], [h, c, cipher('mobile', 'y'.repeat(80000))]]) {
    const wire = JSON.stringify(m, null, 2).replace('"seq": 7', '"seq": 9007199254740993');
    a.send(wire); assert.equal(await b.raw(), wire);
  }
});

run('auth binds route, role and device; spoofed frames never reach host', async t => {
  const f = await fixture(t), h = await f.host(), c = await f.client(h, 'a'); await f.client(h, 'b');
  for (const m of [cipher('b'), pair('b', {}), { ...cipher('a'), routeId: 'another_valid_route' }, { t: 'host.revoke', routeId, deviceId: 'a' }, register]) {
    c.send(m); assert.equal((await c.read()).code, 'UNAUTHORIZED');
  }
  // Same effective JS property twice, including a Unicode-escaped spelling.
  c.send(JSON.stringify(cipher('a')).replace('"deviceId":"a"', '"deviceId":"b","device\\u0049d":"a"'));
  assert.equal((await c.read()).code, 'BAD_FRAME');
  c.send(cipher('a')); assert.deepEqual(await h.read(), cipher('a'));
});

run('replacement and host.revoke close only the addressed device', async t => {
  const f = await fixture(t), h = await f.host(), old = await f.client(h, 'a'), b = await f.client(h, 'b');
  const a = await f.socket(); a.send(join('a')); assert.equal((await a.read()).t, 'client.joined'); assert.equal((await old.closed).code, 4001);
  assert.equal((await h.read()).t, 'peer.left'); assert.equal((await h.read()).t, 'peer.joined');
  h.send({ t: 'host.revoke', routeId, deviceId: 'a' });
  assert.deepEqual(await a.read(), { t: 'error', code: 'REVOKED', message: 'Device revoked by host' });
  const e = await a.closed; assert.equal(e.code, 4003); assert.equal(e.reason, 'revoked');
  assert.deepEqual(await h.read(), { t: 'peer.left', routeId, deviceId: 'a', role: 'client' });
  b.send(cipher('b')); assert.deepEqual(await h.read(), cipher('b'));
});

run('configured frame ceiling rejects oversize text before routing', async t => {
  const f = await fixture(t, { maxFrameBytes: 512 }), h = await f.host(), c = await f.client(h, 'a');
  c.send(cipher('a', 'X'.repeat(512))); assert.equal((await c.read()).code, 'FRAME_TOO_LARGE'); assert.equal((await c.closed).code, 1009);
  assert.equal((await h.read()).t, 'peer.left');
});

run('token buckets are per connection; pairing has independent IP and byte caps', async t => {
  const f = await fixture(t, { burst: 2, framesPerSecond: 1 }), h = await f.host(), c = await f.client(h, 'a');
  c.send(cipher('a')); assert.deepEqual(await h.read(), cipher('a')); c.send(cipher('a')); assert.equal((await c.read()).code, 'RATE_LIMITED');
  h.send({ t: 'ping', ts: 123 }); assert.deepEqual(await h.read(), { t: 'pong', ts: 123 });
  const g = await fixture(t), host = await g.host(), a = await g.client(host, 'a'), b = await g.client(host, 'b');
  a.send(pair('a', 'x'.repeat(16384))); assert.equal((await a.read()).code, 'FRAME_TOO_LARGE');
  for (let i = 0; i < 10; i++) a.send(pair('a', i));
  for (let i = 0; i < 10; i++) assert.equal((await host.read()).payload, i);
  b.send(pair('b', 11)); assert.equal((await b.read()).code, 'RATE_LIMITED');
});

run('ticket auth uses the preimage; concurrent redemption wins once and cannot reopen route', async t => {
  const f = await fixture(t), h = await f.host();
  assert.equal((await f.post('/v1/tickets', {}, hostSecretHash)).status, 401);
  const start = Date.now(), res = await f.post('/v1/tickets'); assert.equal(res.status, 200);
  const { joinToken, expiresAt } = await res.json(); assert.match(joinToken, /^[A-Za-z0-9_-]{43}$/); assert.ok(expiresAt >= start + 120000 && expiresAt <= Date.now() + 120000);
  const a = await f.socket(), b = await f.socket(); a.send(join('a')); assert.equal((await a.read()).code, 'UNAUTHORIZED');
  a.send({ ...join('a'), joinToken }); b.send({ ...join('b'), joinToken }); const replies = await Promise.all([a.read(), b.read()]);
  assert.equal(replies.filter(m => m.t === 'client.joined').length, 1); assert.equal(replies.filter(m => m.code === 'UNAUTHORIZED').length, 1); assert.equal((await h.read()).t, 'peer.joined');
  const c = await f.socket(); c.send(join('c')); assert.equal((await c.read()).code, 'UNAUTHORIZED');
});

run('required tickets and expiration boundary are enforced', async t => {
  const f = await fixture(t, { requireTickets: true }); await f.host(); const c = await f.socket();
  c.send(join('a')); assert.equal((await c.read()).code, 'UNAUTHORIZED');
  const { joinToken, expiresAt } = await (await f.post('/v1/tickets')).json(); t.mock.method(Date, 'now', () => expiresAt);
  c.send({ ...join('a'), joinToken }); assert.equal((await c.read()).code, 'UNAUTHORIZED');
});

run('wake rejects plaintext and oversized bodies, authenticates, rate limits, sends only generic payload', async t => {
  const events = [], f = await fixture(t, { pushAdapter: async e => events.push(e) }); await f.host();
  const data = { deviceId: 'd1', wakeId: 'w1' }, path = '/v1/push/wake';
  assert.equal((await f.post(path, data, 'incorrect')).status, 401);
  for (const field of ['title', 'body', 'prompt', 'routeId']) assert.equal((await f.post(path, { ...data, [field]: 'private' })).status, 400);
  assert.equal((await f.post(path, { ...data, wakeId: {} })).status, 400);
  assert.equal((await f.post(path, { body: 'x'.repeat(4096) })).status, 413);
  assert.deepEqual(events, []);
  for (let i = 0; i < 10; i++) assert.equal((await f.post(path, data)).status, 200);
  assert.equal((await f.post(path, data)).status, 429);
  assert.deepEqual(events, Array(10).fill({ routeId, ...data, message: 'PI-Desktop 有更新' }));
});

// A raw client supplements the browser API, which intentionally hides masking,
// fragmentation and protocol control frames. Built-in WebSocket covers normal IO.
function masked(op, payload, fin = true) {
  const b = Buffer.from(payload), mask = randomBytes(4);
  assert.ok(b.length < 126); const frame = Buffer.concat([Buffer.from([(fin ? 128 : 0) | op, 128 | b.length]), mask, b]);
  for (let i = 0; i < b.length; i++) frame[i + 6] ^= mask[i & 3]; return frame;
}
async function rawSocket(t, base) {
  const req = http.get(base + '/ws', { headers: { connection: 'upgrade', upgrade: 'websocket', 'sec-websocket-key': randomBytes(16).toString('base64'), 'sec-websocket-version': '13' } });
  const [, socket, head] = await once(req, 'upgrade'); t.after(() => socket.destroy()); socket.on('error', () => {});
  let buf = head; const iter = socket[Symbol.asyncIterator]();
  async function read(n) { while (buf.length < n) { const { value, done } = await iter.next(); assert.ok(!done); buf = Buffer.concat([buf, value]); } const part = buf.subarray(0, n); buf = buf.subarray(n); return part; }
  return { socket, async frame() { const hdr = await read(2); assert.ok(hdr[1] < 126); return [hdr[0] & 15, await read(hdr[1])]; } };
}
run('fragmented text, pipelined control ping/pong and close echo', async t => {
  const f = await fixture(t), { socket, frame } = await rawSocket(t, f.base);
  const data = Buffer.concat([masked(1, '{"t":"p', false), masked(9, 'hello'), masked(0, 'ing","ts":1}'), masked(8, [3, 232])]);
  for (const byte of data) socket.write(Buffer.from([byte]));
  assert.deepEqual(await frame(), [10, Buffer.from('hello')]); assert.deepEqual(JSON.parse((await frame())[1]), { t: 'pong', ts: 1 });
  assert.deepEqual(await frame(), [8, Buffer.from([3, 232])]);
});
run('malformed RFC frames and fragmented oversize messages are closed with specific status', async t => {
  const f = await fixture(t, { maxFrameBytes: 16 });
  for (const [input, code] of [
    [Buffer.from([0x81, 0]), 1002], [masked(0, 'x'), 1002], [masked(1, [0xff]), 1007],
    [masked(9, 'x', false), 1002], [masked(2, []), 1003],
    [Buffer.concat([masked(1, 'a'.repeat(10), false), masked(0, 'a'.repeat(7))]), 1009],
  ]) {
    const r = await rawSocket(t, f.base); r.socket.write(input);
    if (code === 1009) assert.equal(JSON.parse((await r.frame())[1]).code, 'FRAME_TOO_LARGE');
    const [op, payload] = await r.frame(); assert.equal(op, 8); assert.equal(payload.readUInt16BE(), code); r.socket.destroy();
  }
});

run('shutdown drains upgraded sockets and reports going-away status', async t => {
  const f = await fixture(t), h = await f.host(), c = await f.client(h, 'a');
  const done = f.server.shutdown();
  assert.equal((await h.closed).code, 1001); assert.equal((await c.closed).code, 1001); await done;
});
