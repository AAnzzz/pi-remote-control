import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { acceptWebSocket, rejectUpgrade } from './ws-server.mjs';

const protocol = 'pi-relay.v1', wakeText = 'PI-Desktop 有更新';
const sha = value => createHash('sha256').update(value).digest();
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const routeId = value => id(value) && value.length >= 16;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const send = (peer, msg) => peer?.text(JSON.stringify(msg));
const messages = { BAD_FRAME: 'Invalid frame', ROUTE_NOT_FOUND: 'Peer not online', UNAUTHORIZED: 'Unauthorized', RATE_LIMITED: 'Rate limited', REVOKED: 'Device revoked by host', FRAME_TOO_LARGE: 'Frame too large', PUSH_FAILED: 'Wake dispatch failed' };
const error = code => ({ t: 'error', code, message: messages[code] });

// Parse once for syntax, but forward the original text (including ciphertext,
// number precision and whitespace). Disallow duplicate outer keys: otherwise a
// recipient with a first-key-wins parser could see different routing metadata.
function parseOuter(text) {
  const msg = JSON.parse(text);
  if (!object(msg)) throw new Error();
  let depth = 0, key = false;
  const seen = new Set();
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      if (key && depth === 1) {
        const name = JSON.parse(text.slice(start, i + 1));
        if (seen.has(name)) throw new Error();
        seen.add(name); key = false;
      }
    } else if (c === '{' || c === '[') { if (++depth === 1) key = true; }
    else if (c === '}' || c === ']') depth--;
    else if (depth === 1 && c === ',') key = true;
  }
  return msg;
}
function bucket(cap, perSecond) {
  let tokens = cap, last = performance.now();
  return () => {
    const now = performance.now(); tokens = Math.min(cap, tokens + (now - last) * perSecond / 1000); last = now;
    if (tokens < 1) return false;
    tokens--; return true;
  };
}
function integer(n, limit) {
  if (!Number.isSafeInteger(n) || n < 1 || n > limit) throw new Error('Invalid relay limit');
  return n;
}
async function body(req) {
  const chunks = []; let size = 0;
  // Do not destroy the socket before the 413 can be written.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    if ((size += chunk.length) > 4096) { req.resume(); throw new RangeError(); }
    chunks.push(chunk);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}
function pushAdapter(url) {
  if (!url) return async () => {}; // No provider configured: generic wake sink.
  if (!['https:', 'http:'].includes(new URL(url).protocol)) throw new Error('Invalid webhook scheme');
  return async event => {
    const res = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) });
    await res.body?.cancel(); if (!res.ok) throw new Error();
  };
}

export function createRelayServer(options = {}) {
  const maxFrameBytes = integer(options.maxFrameBytes ?? 262144, 16 << 20);
  const heartbeatMs = integer(options.heartbeatMs ?? 25000, 3600000);
  const burst = integer(options.burst ?? 120, 1000000), rate = integer(options.framesPerSecond ?? 60, 1000000);
  const push = options.pushAdapter ?? pushAdapter(options.pushWebhookUrl);
  const routes = new Map(), peers = new Set(), ips = new Map();
  let stopping = false;
  function pairAllowed(ip) {
    let entry = ips.get(ip);
    if (!entry) {
      if (ips.size >= 16384) return false;
      entry = { take: bucket(10, 10 / 60) }; ips.set(ip, entry);
    }
    entry.last = performance.now(); return entry.take();
  }
  function authenticated(req) {
    const secret = req.headers['x-host-secret'], route = routes.get(req.headers['x-route-id']);
    if (!route?.host || typeof secret !== 'string' || !secret || !timingSafeEqual(sha(secret), route.hash)) return;
    return route;
  }
  const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 8192 }, async (req, res) => {
    const reply = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    try {
      const path = req.url.split('?')[0];
      if (path === '/healthz' && req.method === 'GET') {
        let clients = 0, online = 0;
        for (const r of routes.values()) { clients += r.clients.size; if (r.host) online++; }
        return reply(200, { ok: true, version: '1.0.0', protocol, stats: { routes: online, clients } });
      }
      if (req.method !== 'POST' || !['/v1/tickets', '/v1/push/wake'].includes(path)) return reply(404, error('ROUTE_NOT_FOUND'));
      const route = authenticated(req);
      if (!route) return reply(401, error('UNAUTHORIZED'));
      let raw, msg;
      try { raw = await body(req); msg = raw === '' && path === '/v1/tickets' ? {} : parseOuter(raw); }
      catch (err) { return err instanceof RangeError ? reply(413, error('FRAME_TOO_LARGE')) : reply(400, error('BAD_FRAME')); }
      if (!route.host) return reply(401, error('UNAUTHORIZED'));
      if (path === '/v1/tickets') {
        if (Object.keys(msg).length) return reply(400, error('BAD_FRAME'));
        const now = Date.now();
        for (const [k, exp] of route.tickets) if (exp <= now) route.tickets.delete(k);
        if (route.tickets.size >= 128 || !route.issue()) return reply(429, error('RATE_LIMITED'));
        const joinToken = randomBytes(32).toString('base64url'), expiresAt = now + 120000;
        route.tickets.set(sha(joinToken).toString('hex'), expiresAt); route.locked = true;
        return reply(200, { joinToken, expiresAt });
      }
      if (Object.keys(msg).length !== 2 || !id(msg.deviceId) || !id(msg.wakeId)) return reply(400, error('BAD_FRAME'));
      if (!route.wake()) return reply(429, error('RATE_LIMITED'));
      try { await push({ routeId: route.id, deviceId: msg.deviceId, wakeId: msg.wakeId, message: wakeText }); }
      catch { return reply(502, error('PUSH_FAILED')); }
      reply(200, { ok: true });
    } catch { if (!res.headersSent) reply(400, error('BAD_FRAME')); else res.destroy(); }
  });
  function announce(route, msg) { for (const client of route.clients.values()) send(client, msg); }
  function detach(p) {
    const r = p.route; if (!r) return;
    p.route = null;
    if (r.host === p) {
      r.host = null; announce(r, { t: 'peer.left', routeId: r.id, role: 'host' });
    } else if (r.clients.get(p.deviceId) === p) {
      r.clients.delete(p.deviceId); send(r.host, { t: 'peer.left', routeId: r.id, deviceId: p.deviceId, role: 'client' });
    }
  }
  function receive(p, raw) {
    const reject = code => send(p, error(code));
    if (!p.take()) return reject('RATE_LIMITED');
    let m;
    try { m = parseOuter(raw); } catch { return reject('BAD_FRAME'); }
    if (m.t === 'ping' || m.t === 'pong') {
      if (m.ts !== undefined && !Number.isSafeInteger(m.ts)) return reject('BAD_FRAME');
      if (m.t === 'ping') send(p, { t: 'pong', ts: m.ts });
      return;
    }
    if (!routeId(m.routeId)) return reject('BAD_FRAME');
    let r = routes.get(m.routeId);
    if (m.t === 'host.register') {
      if (p.route) return reject('UNAUTHORIZED');
      if (!id(m.hostId) || typeof m.hostSecretHash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(m.hostSecretHash)) return reject('BAD_FRAME');
      const hash = Buffer.from(m.hostSecretHash, 'hex');
      if (r && !timingSafeEqual(hash, r.hash)) return reject('UNAUTHORIZED');
      if (!r) {
        if (routes.size >= 4096) return reject('RATE_LIMITED');
        r = { id: m.routeId, hash, clients: new Map(), tickets: new Map(), locked: !!options.requireTickets, wake: bucket(10, 10 / 60), issue: bucket(30, 1) };
        routes.set(r.id, r);
      }
      if (r.host) { const old = r.host; detach(old); old.close(4001, 'replaced'); }
      r.host = p; p.route = r;
      send(p, { t: 'host.registered', routeId: r.id, maxFrameBytes, heartbeatMs });
      for (const [deviceId, client] of r.clients) {
        send(client, { t: 'peer.joined', role: 'host', routeId: r.id, hostOnline: true });
        send(p, { t: 'peer.joined', deviceId, routeId: r.id, hostOnline: true });
      }
      return;
    }
    if (m.t === 'client.join') {
      if (p.route) return reject('UNAUTHORIZED');
      if (!id(m.deviceId)) return reject('BAD_FRAME');
      if (!r?.host) return reject('ROUTE_NOT_FOUND');
      if (r.locked || m.joinToken !== undefined) {
        if (!id(m.joinToken) || m.joinToken.length !== 43) return reject('UNAUTHORIZED');
        const key = sha(m.joinToken).toString('hex'), exp = r.tickets.get(key);
        r.tickets.delete(key); if (!exp || exp <= Date.now()) return reject('UNAUTHORIZED');
      }
      const old = r.clients.get(m.deviceId);
      if (old) { detach(old); old.close(4001, 'replaced'); }
      r.clients.set(m.deviceId, p); p.route = r; p.deviceId = m.deviceId;
      const fields = { routeId: r.id, deviceId: p.deviceId, hostOnline: true };
      send(p, { t: 'client.joined', ...fields }); send(r.host, { t: 'peer.joined', ...fields }); return;
    }
    if (!r || r !== p.route) return reject('UNAUTHORIZED');
    if (!id(m.deviceId)) return reject('BAD_FRAME');
    const host = r.host === p;
    if (!host && (p.deviceId !== m.deviceId || r.clients.get(m.deviceId) !== p)) return reject('UNAUTHORIZED');
    const remote = host ? r.clients.get(m.deviceId) : r.host;
    if (m.t === 'host.revoke') {
      if (!host) return reject('UNAUTHORIZED');
      if (!remote) return reject('ROUTE_NOT_FOUND');
      send(remote, error('REVOKED')); detach(remote); remote.close(4003, 'revoked'); return;
    }
    if (m.t === 'pair') {
      if (Buffer.byteLength(raw) > 16384) return reject('FRAME_TOO_LARGE');
      if (Object.keys(m).length !== 4 || !Object.hasOwn(m, 'payload')) return reject('BAD_FRAME');
      if (!pairAllowed(p.ip)) return reject('RATE_LIMITED');
    } else if (m.t === 'cipher') {
      if (Object.keys(m).length !== 5 || !id(m.frameId) || !object(m.envelope)) return reject('BAD_FRAME');
    } else return reject('BAD_FRAME');
    if (!remote || !remote.text(raw)) return reject('ROUTE_NOT_FOUND');
  }
  server.on('upgrade', (req, socket, head) => {
    if (req.url.split('?')[0] !== '/ws') return rejectUpgrade(socket, '404 Not Found');
    if (stopping || peers.size >= 4096) return rejectUpgrade(socket, '503 Service Unavailable');
    acceptWebSocket(req, socket, head, maxFrameBytes, p => {
      peers.add(p); p.take = bucket(burst, rate); p.ip = socket.remoteAddress; p.alive = true; p.started = Date.now();
      p.onText = raw => receive(p, raw); p.onPong = () => { p.alive = true; };
      p.onClose = () => { detach(p); peers.delete(p); };
    });
  });
  // Raw HTTP parse errors can contain header bytes. Never log runtime errors.
  server.on('clientError', (_err, socket) => socket.destroy());
  const timer = setInterval(() => {
    for (const p of peers) {
      if (!p.alive || (!p.route && Date.now() - p.started >= 2 * heartbeatMs)) { p.destroy(); continue; }
      p.alive = false; p.ping();
    }
    for (const [ip, entry] of ips) if (performance.now() - entry.last >= 60000) ips.delete(ip);
  }, heartbeatMs).unref();
  server.once('close', () => clearInterval(timer));
  let shutdown;
  server.shutdown = () => {
    if (shutdown) return shutdown;
    stopping = true; clearInterval(timer);
    for (const p of peers) p.close(1001, 'shutdown');
    shutdown = new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    return shutdown;
  };
  return server;
}
