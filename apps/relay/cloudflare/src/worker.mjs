/**
 * PI Remote Control — Cloudflare Workers + SQLite Durable Objects Blind Relay
 * Protocol: `pi-relay.v1` (zero-knowledge ciphertext forwarder)
 *
 * Uses Cloudflare Durable Objects WebSocket Hibernation API so idle connections
 * remain open on Cloudflare's edge with zero active compute billing, and survives
 * hibernation wakeups via WebSocket attachments + durable SQLite storage.
 */

const PROTOCOL = "pi-relay.v1";
const VERSION = "1.1.0-cf";
const MAX_FRAME_BYTES = 262_144; // 256 KiB
const MAX_PAIR_BYTES = 16_384;
const MAX_CONNECTIONS = 1024;
const MAX_CLIENTS_PER_ROUTE = 16;
const HEARTBEAT_MS = 25_000;

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const HEX_64_RE = /^[0-9a-fA-F]{64}$/;

const ERR_MESSAGES = {
  BAD_FRAME: "Invalid frame",
  ROUTE_NOT_FOUND: "Peer not online",
  UNAUTHORIZED: "Unauthorized",
  RATE_LIMITED: "Rate limited",
  REVOKED: "Device revoked by host",
  FRAME_TOO_LARGE: "Frame too large",
};

const encoder = new TextEncoder();

function isValidId(v) {
  return typeof v === "string" && SAFE_ID_RE.test(v);
}

function isValidRouteId(v) {
  return isValidId(v) && v.length >= 16;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function errorFrame(code) {
  return JSON.stringify({ t: "error", code, message: ERR_MESSAGES[code] || code });
}

function safeSend(ws, text) {
  try {
    ws.send(text);
    return true;
  } catch {
    return false;
  }
}

function constantTimeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la.length !== lb.length) return false;
  let diff = 0;
  for (let i = 0; i < la.length; i++) {
    diff |= la.charCodeAt(i) ^ lb.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Parse outer JSON once while rejecting duplicate top-level keys,
 * preserving raw wire text for byte-exact forwarding.
 */
export function parseOuterStrict(text) {
  const msg = JSON.parse(text);
  if (!isPlainObject(msg)) throw new Error("Not an object");
  let depth = 0;
  let expectKey = false;
  const seen = new Set();
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      if (expectKey && depth === 1) {
        const name = JSON.parse(text.slice(start, i + 1));
        if (seen.has(name)) throw new Error("Duplicate top-level key");
        seen.add(name);
        expectKey = false;
      }
    } else if (c === "{" || c === "[") {
      if (++depth === 1) expectKey = true;
    } else if (c === "}" || c === "]") {
      depth--;
    } else if (depth === 1 && c === ",") {
      expectKey = true;
    }
  }
  return msg;
}

export class PiRelayHub {
  constructor(ctx) {
    this.ctx = ctx;
    this._hashCache = new Map();
    this._buckets = new WeakMap();
    this._pairBuckets = new WeakMap();
  }

  _takeFromBucket(map, ws, cap, ratePerSec) {
    const now = Date.now();
    let b = map.get(ws);
    if (!b) {
      b = { tokens: cap, last: now };
      map.set(ws, b);
    }
    b.tokens = Math.min(cap, b.tokens + ((now - b.last) * ratePerSec) / 1000);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  _getMeta(ws) {
    try {
      const meta = ws.deserializeAttachment?.();
      if (meta && typeof meta === "object") return meta;
    } catch {
      // ignore
    }
    return { role: null, routeId: null, deviceId: null };
  }

  _setMeta(ws, meta) {
    try {
      ws.serializeAttachment?.(meta);
    } catch {
      // ignore
    }
  }

  async _getRouteHash(routeId) {
    if (this._hashCache.has(routeId)) return this._hashCache.get(routeId);
    const stored = await this.ctx.storage.get(`route_hash:${routeId}`);
    if (typeof stored === "string") {
      this._hashCache.set(routeId, stored);
      return stored;
    }
    return null;
  }

  async _setRouteHash(routeId, hashHex) {
    const norm = hashHex.toLowerCase();
    this._hashCache.set(routeId, norm);
    await this.ctx.storage.put(`route_hash:${routeId}`, norm);
  }

  _findHostWs(routeId) {
    for (const sock of this.ctx.getWebSockets()) {
      const meta = this._getMeta(sock);
      if (meta.role === "host" && meta.routeId === routeId) return sock;
    }
    return null;
  }

  _findClientWs(routeId, deviceId) {
    for (const sock of this.ctx.getWebSockets()) {
      const meta = this._getMeta(sock);
      if (meta.role === "client" && meta.routeId === routeId && meta.deviceId === deviceId) return sock;
    }
    return null;
  }

  _findClientsForRoute(routeId) {
    const out = [];
    for (const sock of this.ctx.getWebSockets()) {
      const meta = this._getMeta(sock);
      if (meta.role === "client" && meta.routeId === routeId) {
        out.push({ sock, deviceId: meta.deviceId });
      }
    }
    return out;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz" && request.method === "GET") {
      return new Response(
        JSON.stringify({
          ok: true,
          version: VERSION,
          protocol: PROTOCOL,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }
      );
    }

    if (url.pathname === "/ws") {
      const upgrade = request.headers.get("upgrade") || "";
      if (upgrade.toLowerCase() !== "websocket") {
        return new Response(errorFrame("BAD_FRAME"), {
          status: 426,
          headers: { "content-type": "application/json", upgrade: "websocket" },
        });
      }
      if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS) {
        return new Response(errorFrame("RATE_LIMITED"), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this._setMeta(server, { role: null, routeId: null, deviceId: null });
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response(errorFrame("ROUTE_NOT_FOUND"), {
      status: 404,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") {
      safeSend(ws, errorFrame("BAD_FRAME"));
      return;
    }
    const byteLen = encoder.encode(message).byteLength;
    if (byteLen > MAX_FRAME_BYTES) {
      safeSend(ws, errorFrame("FRAME_TOO_LARGE"));
      return;
    }
    if (!this._takeFromBucket(this._buckets, ws, 120, 60)) {
      safeSend(ws, errorFrame("RATE_LIMITED"));
      return;
    }

    let m;
    try {
      m = parseOuterStrict(message);
    } catch {
      safeSend(ws, errorFrame("BAD_FRAME"));
      return;
    }

    if (m.t === "ping" || m.t === "pong") {
      if (m.ts !== undefined && !Number.isSafeInteger(m.ts)) {
        safeSend(ws, errorFrame("BAD_FRAME"));
        return;
      }
      if (m.t === "ping") safeSend(ws, JSON.stringify({ t: "pong", ts: m.ts }));
      return;
    }

    if (!isValidRouteId(m.routeId)) {
      safeSend(ws, errorFrame("BAD_FRAME"));
      return;
    }

    const meta = this._getMeta(ws);

    if (m.t === "host.register") {
      if (meta.role) {
        safeSend(ws, errorFrame("UNAUTHORIZED"));
        return;
      }
      if (!isValidId(m.hostId) || typeof m.hostSecretHash !== "string" || !HEX_64_RE.test(m.hostSecretHash)) {
        safeSend(ws, errorFrame("BAD_FRAME"));
        return;
      }
      const existingHash = await this._getRouteHash(m.routeId);
      if (existingHash && !constantTimeEqualHex(existingHash, m.hostSecretHash)) {
        safeSend(ws, errorFrame("UNAUTHORIZED"));
        return;
      }
      if (!existingHash) {
        await this._setRouteHash(m.routeId, m.hostSecretHash);
      }

      const prevHost = this._findHostWs(m.routeId);
      if (prevHost && prevHost !== ws) {
        this._setMeta(prevHost, { role: null, routeId: null, deviceId: null });
        try {
          prevHost.close(4001, "replaced");
        } catch {
          // ignore
        }
      }

      this._setMeta(ws, { role: "host", routeId: m.routeId, deviceId: null });
      safeSend(
        ws,
        JSON.stringify({
          t: "host.registered",
          routeId: m.routeId,
          maxFrameBytes: MAX_FRAME_BYTES,
          heartbeatMs: HEARTBEAT_MS,
        })
      );

      for (const { sock, deviceId } of this._findClientsForRoute(m.routeId)) {
        safeSend(sock, JSON.stringify({ t: "peer.joined", role: "host", routeId: m.routeId, hostOnline: true }));
        safeSend(ws, JSON.stringify({ t: "peer.joined", deviceId, routeId: m.routeId, hostOnline: true }));
      }
      return;
    }

    if (m.t === "client.join") {
      if (meta.role) {
        safeSend(ws, errorFrame("UNAUTHORIZED"));
        return;
      }
      if (!isValidId(m.deviceId)) {
        safeSend(ws, errorFrame("BAD_FRAME"));
        return;
      }
      const hostWs = this._findHostWs(m.routeId);
      if (!hostWs) {
        safeSend(ws, errorFrame("ROUTE_NOT_FOUND"));
        return;
      }

      const prevClient = this._findClientWs(m.routeId, m.deviceId);
      if (!prevClient && this._findClientsForRoute(m.routeId).length >= MAX_CLIENTS_PER_ROUTE) {
        safeSend(ws, errorFrame("RATE_LIMITED"));
        return;
      }
      if (prevClient && prevClient !== ws) {
        this._setMeta(prevClient, { role: null, routeId: null, deviceId: null });
        try {
          prevClient.close(4001, "replaced");
        } catch {
          // ignore
        }
      }

      this._setMeta(ws, { role: "client", routeId: m.routeId, deviceId: m.deviceId });
      const fields = { routeId: m.routeId, deviceId: m.deviceId, hostOnline: true };
      safeSend(ws, JSON.stringify({ t: "client.joined", ...fields }));
      safeSend(hostWs, JSON.stringify({ t: "peer.joined", ...fields }));
      return;
    }

    // Authenticated forwarding frames
    if (!meta.role || meta.routeId !== m.routeId) {
      safeSend(ws, errorFrame("UNAUTHORIZED"));
      return;
    }
    if (!isValidId(m.deviceId)) {
      safeSend(ws, errorFrame("BAD_FRAME"));
      return;
    }
    const isHost = meta.role === "host";
    if (!isHost && meta.deviceId !== m.deviceId) {
      safeSend(ws, errorFrame("UNAUTHORIZED"));
      return;
    }

    const remote = isHost ? this._findClientWs(m.routeId, m.deviceId) : this._findHostWs(m.routeId);

    if (m.t === "host.revoke") {
      if (!isHost) {
        safeSend(ws, errorFrame("UNAUTHORIZED"));
        return;
      }
      if (!remote) {
        safeSend(ws, errorFrame("ROUTE_NOT_FOUND"));
        return;
      }
      safeSend(remote, errorFrame("REVOKED"));
      this._setMeta(remote, { role: null, routeId: null, deviceId: null });
      try {
        remote.close(4003, "revoked");
      } catch {
        // ignore
      }
      return;
    }

    if (m.t === "pair") {
      if (byteLen > MAX_PAIR_BYTES) {
        safeSend(ws, errorFrame("FRAME_TOO_LARGE"));
        return;
      }
      if (Object.keys(m).length !== 4 || !Object.hasOwn(m, "payload")) {
        safeSend(ws, errorFrame("BAD_FRAME"));
        return;
      }
      if (!this._takeFromBucket(this._pairBuckets, ws, 10, 10 / 60)) {
        safeSend(ws, errorFrame("RATE_LIMITED"));
        return;
      }
    } else if (m.t === "cipher") {
      if (Object.keys(m).length !== 5 || !isValidId(m.frameId) || !isPlainObject(m.envelope)) {
        safeSend(ws, errorFrame("BAD_FRAME"));
        return;
      }
    } else {
      safeSend(ws, errorFrame("BAD_FRAME"));
      return;
    }

    if (!remote || !safeSend(remote, message)) {
      safeSend(ws, errorFrame("ROUTE_NOT_FOUND"));
    }
  }

  async webSocketClose(ws) {
    this._handleDisconnect(ws);
  }

  async webSocketError(ws) {
    this._handleDisconnect(ws);
  }

  _handleDisconnect(ws) {
    const meta = this._getMeta(ws);
    if (!meta.role || !meta.routeId) return;
    this._setMeta(ws, { role: null, routeId: null, deviceId: null });

    if (meta.role === "host") {
      for (const { sock } of this._findClientsForRoute(meta.routeId)) {
        safeSend(sock, JSON.stringify({ t: "peer.left", routeId: meta.routeId, role: "host" }));
      }
    } else if (meta.role === "client") {
      const hostWs = this._findHostWs(meta.routeId);
      if (hostWs) {
        safeSend(
          hostWs,
          JSON.stringify({ t: "peer.left", routeId: meta.routeId, deviceId: meta.deviceId, role: "client" })
        );
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws" || url.pathname === "/healthz") {
      const id = env.RELAY_HUB.idFromName("global-hub");
      const stub = env.RELAY_HUB.get(id);
      return stub.fetch(request);
    }
    return new Response("Not Found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  },
};
