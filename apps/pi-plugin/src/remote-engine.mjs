/**
 * PI Remote Control Core Engine:
 * - Unified transport supporting both Direct LAN/Tailscale WS Server and Outbound Blind Relay WS
 * - X25519 + HKDF-SHA256 + AES-256-GCM E2EE with per-device ReplayWindow
 * - 120s single-use QR pairing with mandatory desktop 6-digit SAS approval
 * - Full RPC dispatch with idempotency, cursor replay log, 100ms streaming delta coalescing,
 *   loopback agentExtension stream ingress, and active-turn pending-approval polling.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { attachMinimalWsServer } from "./ws-minimal.mjs";
import { getGitDiffSummary, getGitFilePatch } from "./git-diff.mjs";
import { extractMessageParts, applyToolTraceToWorkState } from "./host-adapter.mjs";
import {
  generateX25519KeyPair,
  computeSharedSecret,
  verifyInviteProof,
  derivePairingMaterial,
  encryptEnvelope,
  decryptEnvelope,
  ReplayWindow,
  sha256Hex,
  randomId,
  randomBytes,
  bytesToBase64,
  base64ToBytes,
  validateRpcRequest,
  isAllowedWsUrl,
  SAFE_ID_RE,
  PAIRING_TTL_MS,
  MAX_FRAME_BYTES,
  EventCursorLog,
  StreamDeltaCoalescer,
  IdempotencyStore,
} from "./vendor/protocol/index.mjs";

const PLUGIN_VERSION = "0.1.5";
const MAX_RECENT_TURNS = 128;

function collectLanIpv4Addresses() {
  const ifaces = os.networkInterfaces();
  const tailscale = [];
  const lan = [];
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const info of entries) {
      if (info.family !== "IPv4" || info.internal) continue;
      const addr = info.address;
      const m = /^(\d+)\.(\d+)\./.exec(addr);
      if (!m) continue;
      const [a, b] = [Number(m[1]), Number(m[2])];
      if (a === 100 && b >= 64 && b <= 127) {
        tailscale.push(addr);
      } else if (a === 192 && b === 168 || a === 10 || (a === 172 && b >= 16 && b <= 31)) {
        lan.push(addr);
      }
    }
  }
  return [...tailscale, ...lan, "127.0.0.1"];
}

export class RemoteControlEngine {
  constructor({ vault, hostAdapter, settings = {} }) {
    this.vault = vault;
    this.hostAdapter = hostAdapter;
    this.settings = {
      hostName: "",
      directEnabled: true,
      directPort: 47921,
      directOnly: false,
      relayUrl: "",
      allowMcpHeadlessResolve: true,
      ...settings,
    };

    this.cursorLog = new EventCursorLog();
    this.idempotency = new IdempotencyStore();
    this.coalescer = new StreamDeltaCoalescer({
      flushIntervalMs: 100,
      maxChunkBytes: 8192,
      onFlush: (chunk) => {
        this._broadcastTransient("stream.delta", chunk, chunk.sessionId);
      },
    });

    // Active pairing invites (inviteId -> inviteRecord)
    this.invites = new Map();
    // Pending human SAS confirmations (pendingId -> { pendingId, inviteId, deviceId, deviceName, sasCode, sessionKeyB64, keyId, transport, createdAt })
    this.pendingPairings = new Map();

    // Connected direct clients: deviceId -> { ws, replayWindow, txSeq, transport: 'direct' }
    this.directPeers = new Map();
    // Connected relay clients: deviceId -> { replayWindow, txSeq, transport: 'relay' }
    this.relayPeers = new Map();
    // Unauthenticated direct sockets awaiting pair/join
    this.directSockets = new Set();

    this.directServer = null;
    this.directActualPort = null;
    this.bridgeServer = null;
    this.bridgeToken = null;
    this.bridgeFilePath = path.join(this.vault.dataDir, "stream-bridge.json");

    this.relayWs = null;
    this.relayStatus = "disconnected";
    this.relayReconnectTimer = null;
    this.relayBackoffMs = 1000;
    this.relayHeartbeatTimer = null;

    this.pendingPollTimer = null;
    this._lastPendingDigest = "";
    this._running = false;
    this._streamBuffers = new Map(); // sessionId -> last seen assistant text length for delta extraction
    this._lastCompletedTurns = new Map(); // sessionId -> most recently ended turn (IDs and counters only)
    this._liveWorkState = new Map(); // sessionId -> { todos: [], tasks: Map<id, BackgroundTaskItem> }
  }

  async start() {
    if (this._running) return;
    this._running = true;
    this.hostAdapter.setAllowMcpHeadless(this.settings.allowMcpHeadlessResolve);

    await this._startLoopbackStreamBridge();

    if (this.settings.directEnabled) {
      await this._startDirectServer(this.settings.directPort);
    }

    if (!this.settings.directOnly && this.settings.relayUrl) {
      this._connectRelay();
    }

    this._startPendingPoller();
    this.vault.appendAudit("engine.started", {
      directPort: this.directActualPort,
      directOnly: Boolean(this.settings.directOnly),
      relayConfigured: Boolean(this.settings.relayUrl),
    });
  }

  async stop() {
    this._running = false;
    this.coalescer.dispose();

    if (this.pendingPollTimer) {
      clearInterval(this.pendingPollTimer);
      this.pendingPollTimer = null;
    }
    if (this.relayReconnectTimer) {
      clearTimeout(this.relayReconnectTimer);
      this.relayReconnectTimer = null;
    }
    if (this.relayHeartbeatTimer) {
      clearInterval(this.relayHeartbeatTimer);
      this.relayHeartbeatTimer = null;
    }
    if (this.relayWs) {
      try {
        this.relayWs.close(1000, "Host stopping");
      } catch {
        // ignore
      }
      this.relayWs = null;
      this.relayStatus = "disconnected";
    }
    for (const sock of this.directSockets) {
      try {
        sock.close(1001, "Host stopping");
      } catch {
        // ignore
      }
    }
    this.directSockets.clear();
    this.directPeers.clear();
    this.relayPeers.clear();

    if (this.directServer) {
      await new Promise((resolve) => this.directServer.close(() => resolve()));
      this.directServer = null;
      this.directActualPort = null;
    }
    if (this.bridgeServer) {
      await new Promise((resolve) => this.bridgeServer.close(() => resolve()));
      this.bridgeServer = null;
    }
    try {
      if (fs.existsSync(this.bridgeFilePath)) fs.unlinkSync(this.bridgeFilePath);
    } catch {
      // ignore
    }
    this.vault.appendAudit("engine.stopped", {});
  }

  async applySettings(nextSettings) {
    const prev = this.settings;
    this.settings = { ...this.settings, ...nextSettings };
    this.hostAdapter.setAllowMcpHeadless(this.settings.allowMcpHeadlessResolve);

    const directChanged =
      prev.directEnabled !== this.settings.directEnabled ||
      prev.directPort !== this.settings.directPort;
    const relayChanged =
      prev.directOnly !== this.settings.directOnly || prev.relayUrl !== this.settings.relayUrl;

    if (directChanged && this._running) {
      if (this.directServer) {
        await new Promise((resolve) => this.directServer.close(() => resolve()));
        this.directServer = null;
        this.directActualPort = null;
      }
      if (this.settings.directEnabled) {
        await this._startDirectServer(this.settings.directPort);
      }
    }

    if (relayChanged && this._running) {
      if (this.relayReconnectTimer) {
        clearTimeout(this.relayReconnectTimer);
        this.relayReconnectTimer = null;
      }
      if (this.relayWs) {
        try {
          this.relayWs.close(1000, "Relay config changed");
        } catch {
          // ignore
        }
        this.relayWs = null;
      }
      this.relayStatus = "disconnected";
      if (!this.settings.directOnly && this.settings.relayUrl) {
        this._connectRelay();
      }
    }
  }

  async _startLoopbackStreamBridge() {
    this.bridgeToken = randomId(24);
    this.bridgeServer = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/internal/stream-event") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.headers["x-bridge-token"] !== this.bridgeToken) {
        res.writeHead(403);
        res.end();
        return;
      }
      const chunks = [];
      let total = 0;
      req.on("data", (chunk) => {
        total += chunk.length;
        if (total <= MAX_FRAME_BYTES) chunks.push(chunk);
      });
      req.on("end", () => {
        res.writeHead(204);
        res.end();
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          this.handleSidecarStreamEvent(payload);
        } catch {
          // ignore malformed event
        }
      });
    });

    await new Promise((resolve, reject) => {
      this.bridgeServer.once("error", reject);
      this.bridgeServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = this.bridgeServer.address();
    fs.writeFileSync(
      this.bridgeFilePath,
      JSON.stringify({ port: addr.port, token: this.bridgeToken, pid: process.pid }),
      { encoding: "utf8", mode: 0o600 }
    );
  }

  _newTurnState(turnId) {
    return { turnId, textLen: 0, thinkingLen: 0, lastFinalMsgId: null };
  }

  _turnState(sessionId, turnId) {
    const active = this._streamBuffers.get(sessionId);
    const ended = this._lastCompletedTurns.get(sessionId);
    // A delayed host notification can belong to the previous turn even after the next starts.
    if (turnId && ended?.turnId === turnId && active?.turnId !== turnId) return ended;
    const state = active || ended;
    if (state && (!turnId || !state.turnId || state.turnId === turnId)) {
      state.turnId ||= turnId;
      return state;
    }
    const next = this._newTurnState(turnId);
    this._streamBuffers.set(sessionId, next);
    return next;
  }

  _finishTurn(sessionId, state) {
    if (this._streamBuffers.get(sessionId) !== state) return;
    this._streamBuffers.delete(sessionId);
    this._lastCompletedTurns.delete(sessionId);
    this._lastCompletedTurns.set(sessionId, state);
    if (this._lastCompletedTurns.size > MAX_RECENT_TURNS) {
      this._lastCompletedTurns.delete(this._lastCompletedTurns.keys().next().value);
    }
    this._emitReplayable("turn.state", { sessionId, turnId: state.turnId, status: "idle" }, sessionId);
  }

  handleSidecarStreamEvent(msg) {
    if (!msg || typeof msg !== "object") return;
    const { type, sessionId, turnId, event } = msg;
    if (!sessionId) return;

    if (type === "turn_start") {
      this._streamBuffers.set(sessionId, this._newTurnState(turnId));
      this._emitReplayable("turn.state", { sessionId, turnId, status: "running" }, sessionId);
      return;
    }

    if (type === "message_update") {
      const m = event?.message || event || {};
      if (m.role && m.role !== "assistant") return;
      const state = this._turnState(sessionId, turnId);
      const parsed = extractMessageParts(m);
      const fullText = parsed.text;
      const fullThinking = parsed.thinking;
      if (fullText.length > state.textLen) {
        const delta = fullText.slice(state.textLen);
        state.textLen = fullText.length;
        this.coalescer.push({ sessionId, turnId, channel: "text", delta });
      }
      if (fullThinking.length > state.thinkingLen) {
        const delta = fullThinking.slice(state.thinkingLen);
        state.thinkingLen = fullThinking.length;
        this.coalescer.push({ sessionId, turnId, channel: "thinking", delta });
      }
      return;
    }

    if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
      this.coalescer.flush();
      const toolName = event?.toolName || event?.name || "tool";
      const status = type === "tool_execution_end" ? (event?.isError ? "error" : "success") : "running";
      this._broadcastTransient(
        "tool.update",
        {
          sessionId,
          turnId,
          phase: type,
          toolCallId: event?.toolCallId || event?.id || null,
          toolName,
          status,
          preview: event?.output ? String(event.output).slice(0, 600) : undefined,
        },
        sessionId
      );

      // Track real TodoWrite & background Bash/Subagent tasks live
      if (toolName === "TodoWrite" || toolName === "Bash" || toolName === "Task" || toolName === "TaskWait" || toolName === "TaskStop" || toolName === "TaskList") {
        let work = this._liveWorkState.get(sessionId);
        if (!work) {
          work = { todos: [], tasks: new Map() };
          this._liveWorkState.set(sessionId, work);
        }
        const prevTodoJson = JSON.stringify(work.todos);
        const changed = applyToolTraceToWorkState(
          {
            toolName,
            toolArgs: event?.args ?? event?.input,
            toolResult: event?.result ?? event?.output,
            toolStatus: status,
            sessionId,
            timestamp: new Date().toISOString(),
          },
          work
        );
        if (changed) {
          if (JSON.stringify(work.todos) !== prevTodoJson) {
            this._emitReplayable("todos.updated", { sessionId, todos: work.todos }, sessionId);
          }
          this._emitReplayable(
            "tasks.updated",
            { sessionId, backgroundTasks: Array.from(work.tasks.values()) },
            sessionId
          );
        }
      }
      return;
    }

    if (type === "message_end") {
      this.coalescer.flush();
      const m = event?.message || event || {};
      if (m.role && m.role !== "assistant") return;
      const parsed = extractMessageParts(m);
      const msgId = m.id || `msg_${randomId(8)}`;
      const state = this._turnState(sessionId, turnId);
      if (state.lastFinalMsgId && this._lastCompletedTurns.get(sessionId) === state) return;
      state.textLen = 0;
      state.thinkingLen = 0;
      if ((parsed.text || parsed.thinking) && msgId !== state.lastFinalMsgId) {
        state.lastFinalMsgId = msgId;
        this._emitReplayable(
          "message.final",
          {
            sessionId,
            turnId,
            message: {
              id: msgId,
              role: "assistant",
              content: parsed.text,
              thinking: parsed.thinking || undefined,
              createdAt: new Date().toISOString(),
            },
          },
          sessionId
        );
      }
      return;
    }

    if (type === "turn_end" || type === "agent_end") {
      this.coalescer.flush();
      this._finishTurn(sessionId, this._turnState(sessionId, turnId));
    }
  }

  /**
   * Fallback sync when host emits `session:turnEnded` (guarantees mobile receives the final assistant
   * reply even if the session's sidecar extension did not emit `message_end` before turn completion).
   */
  async syncTurnCompletionFromHost(sessionId, turnId = null) {
    if (!sessionId) return;
    let state = this._turnState(sessionId, turnId);
    this.coalescer.flush();
    // Without a turn ID or a sidecar turn_start, only the host's message ID distinguishes successive turns.
    const checkHostMessage = !turnId && this._lastCompletedTurns.get(sessionId) === state;
    if (!state.lastFinalMsgId || checkHostMessage) {
      try {
        const detail = await this.hostAdapter.getSession({ sessionId, messageLimit: 12 });
        const lastAssistant = [...(detail.messages || [])]
          .reverse()
          .find((m) => m.role === "assistant" && (m.content || m.thinking));
        // The sidecar may have finalized this turn while getSession was in flight.
        const active = this._streamBuffers.get(sessionId);
        if (active ? active !== state : this._lastCompletedTurns.get(sessionId) !== state) return;
        if (checkHostMessage && state.hostMessageId && lastAssistant && lastAssistant.id !== state.hostMessageId) {
          state = this._newTurnState(turnId);
          this._streamBuffers.set(sessionId, state);
        }
        if (lastAssistant) state.hostMessageId = lastAssistant.id;
        if (lastAssistant && !state.lastFinalMsgId) {
          state.lastFinalMsgId = lastAssistant.id;
          this._emitReplayable(
            "message.final",
            { sessionId, turnId: state.turnId, message: lastAssistant },
            sessionId
          );
        }
      } catch {
        // ignore if host session read fails
      }
    }
    this._finishTurn(sessionId, state);
  }

  async _startDirectServer(port) {
    this.directServer = http.createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            mode: "pi-remote-direct",
            hostId: this.vault.state.hostId,
          })
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    attachMinimalWsServer(this.directServer, {
      path: "/ws",
      maxFrameBytes: MAX_FRAME_BYTES,
      onConnection: (ws) => this._handleDirectConnection(ws),
    });

    await new Promise((resolve, reject) => {
      this.directServer.once("error", reject);
      this.directServer.listen(port, "0.0.0.0", () => resolve());
    });
    this.directActualPort = this.directServer.address().port;
  }

  _handleDirectConnection(ws) {
    this.directSockets.add(ws);
    let boundDeviceId = null;

    ws.on("message", async (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch {
        ws.sendText(JSON.stringify({ t: "error", code: "BAD_FRAME", message: "Invalid JSON" }));
        return;
      }
      if (!frame || typeof frame.t !== "string") return;

      if (frame.t === "ping") {
        ws.sendText(JSON.stringify({ t: "pong", ts: frame.ts || Date.now() }));
        return;
      }

      if (frame.t === "client.join") {
        const deviceId = String(frame.deviceId || "");
        if (!SAFE_ID_RE.test(deviceId)) {
          ws.sendText(JSON.stringify({ t: "error", code: "BAD_FRAME", message: "Invalid deviceId" }));
          return;
        }
        boundDeviceId = deviceId;
        const isPaired = Boolean(this.vault.state.devices[deviceId]);
        if (isPaired) {
          const prev = this.directPeers.get(deviceId);
          if (prev && prev.ws !== ws) {
            try {
              prev.ws.close(4001, "Replaced by newer connection");
            } catch {
              // ignore
            }
          }
          this.directPeers.set(deviceId, {
            ws,
            replayWindow: new ReplayWindow(),
            txSeq: 0,
            transport: "direct",
          });
          this.vault.touchDevice(deviceId);
        }
        ws.sendText(
          JSON.stringify({
            t: "client.joined",
            routeId: this.vault.state.routeId,
            deviceId,
            hostOnline: true,
            paired: isPaired,
          })
        );
        return;
      }

      if (frame.t === "pair") {
        const devId = boundDeviceId || String(frame.deviceId || "");
        await this._handlePairPayload({
          deviceId: devId,
          payload: frame.payload,
          sendBack: (outPayload) =>
            ws.sendText(
              JSON.stringify({
                t: "pair",
                routeId: this.vault.state.routeId,
                deviceId: devId,
                payload: outPayload,
              })
            ),
          onApprovedBind: (approvedDeviceId) => {
            boundDeviceId = approvedDeviceId;
            this.directPeers.set(approvedDeviceId, {
              ws,
              replayWindow: new ReplayWindow(),
              txSeq: 0,
              transport: "direct",
            });
          },
        });
        return;
      }

      if (frame.t === "cipher") {
        if (!boundDeviceId) {
          ws.sendText(JSON.stringify({ t: "error", code: "UNAUTHORIZED", message: "Must join first" }));
          return;
        }
        const peer = this.directPeers.get(boundDeviceId);
        if (!peer || peer.ws !== ws) {
          ws.sendText(JSON.stringify({ t: "error", code: "UNAUTHORIZED", message: "Device not paired" }));
          return;
        }
        await this._handleIncomingCipher(boundDeviceId, frame.envelope, peer);
      }
    });

    ws.on("close", () => {
      this.directSockets.delete(ws);
      if (boundDeviceId) {
        const cur = this.directPeers.get(boundDeviceId);
        if (cur && cur.ws === ws) {
          this.directPeers.delete(boundDeviceId);
        }
      }
    });
  }

  _connectRelay() {
    if (!this._running || this.settings.directOnly) return;
    const url = (this.settings.relayUrl || "").trim();
    if (!url || !isAllowedWsUrl(url, true)) {
      this.relayStatus = "invalid_url";
      return;
    }

    this.relayStatus = "connecting";
    try {
      const ws = new WebSocket(url);
      this.relayWs = ws;

      ws.addEventListener("open", async () => {
        if (this.relayWs !== ws) return;
        const id = this.vault.getHostIdentity(this.settings.hostName);
        const hostSecretHash = await sha256Hex(id.hostSecret);
        ws.send(
          JSON.stringify({
            t: "host.register",
            routeId: id.routeId,
            hostSecretHash,
            hostId: id.hostId,
          })
        );
      });

      ws.addEventListener("message", async (evt) => {
        if (this.relayWs !== ws) return;
        let frame;
        try {
          frame = JSON.parse(String(evt.data));
        } catch {
          return;
        }
        if (frame.t === "host.registered") {
          this.relayStatus = "connected";
          this.relayBackoffMs = 1000;
          if (this.relayHeartbeatTimer) clearInterval(this.relayHeartbeatTimer);
          const hb = Math.max(10_000, Math.min(60_000, Number(frame.heartbeatMs) || 25_000));
          this.relayHeartbeatTimer = setInterval(() => {
            if (this.relayWs && this.relayWs.readyState === WebSocket.OPEN) {
              this.relayWs.send(JSON.stringify({ t: "ping", ts: Date.now() }));
            }
          }, hb);
          return;
        }
        if (frame.t === "peer.joined") {
          const devId = frame.deviceId;
          if (devId && this.vault.state.devices[devId]) {
            this.relayPeers.set(devId, {
              replayWindow: new ReplayWindow(),
              txSeq: 0,
              transport: "relay",
            });
            this.vault.touchDevice(devId);
          }
          return;
        }
        if (frame.t === "peer.left") {
          if (frame.deviceId) this.relayPeers.delete(frame.deviceId);
          return;
        }
        if (frame.t === "pair") {
          const devId = String(frame.deviceId || "");
          await this._handlePairPayload({
            deviceId: devId,
            payload: frame.payload,
            sendBack: (outPayload) => {
              if (this.relayWs && this.relayWs.readyState === WebSocket.OPEN) {
                this.relayWs.send(
                  JSON.stringify({
                    t: "pair",
                    routeId: this.vault.state.routeId,
                    deviceId: devId,
                    payload: outPayload,
                  })
                );
              }
            },
            onApprovedBind: (approvedDeviceId) => {
              this.relayPeers.set(approvedDeviceId, {
                replayWindow: new ReplayWindow(),
                txSeq: 0,
                transport: "relay",
              });
            },
          });
          return;
        }
        if (frame.t === "cipher") {
          const devId = String(frame.deviceId || "");
          if (!this.vault.state.devices[devId]) {
            this._sendRelayRevoke(devId);
            return;
          }
          let peer = this.relayPeers.get(devId);
          if (!peer) {
            peer = { replayWindow: new ReplayWindow(), txSeq: 0, transport: "relay" };
            this.relayPeers.set(devId, peer);
          }
          await this._handleIncomingCipher(devId, frame.envelope, peer);
        }
      });

      const scheduleReconnect = () => {
        if (this.relayWs !== ws) return;
        this.relayWs = null;
        this.relayStatus = "disconnected";
        this.relayPeers.clear();
        if (this.relayHeartbeatTimer) {
          clearInterval(this.relayHeartbeatTimer);
          this.relayHeartbeatTimer = null;
        }
        if (!this._running || this.settings.directOnly || !this.settings.relayUrl) return;
        const delay = Math.min(30_000, this.relayBackoffMs);
        this.relayBackoffMs = Math.min(30_000, this.relayBackoffMs * 2);
        this.relayReconnectTimer = setTimeout(() => this._connectRelay(), delay);
      };

      ws.addEventListener("close", scheduleReconnect);
      ws.addEventListener("error", scheduleReconnect);
    } catch {
      this.relayStatus = "error";
    }
  }

  _sendRelayRevoke(deviceId) {
    if (this.relayWs && this.relayWs.readyState === WebSocket.OPEN) {
      this.relayWs.send(
        JSON.stringify({
          t: "host.revoke",
          routeId: this.vault.state.routeId,
          deviceId,
        })
      );
    }
  }

  _pruneExpiredPairings(now) {
    for (const entries of [this.invites, this.pendingPairings]) {
      for (const [id, entry] of entries) {
        if (entry.expiresAt <= now) entries.delete(id);
      }
    }
  }

  /**
   * Generate a 120-second single-use QR pairing invite (never includes long-term secrets).
   */
  createPairingInvite() {
    const now = Date.now();
    this._pruneExpiredPairings(now);

    const identity = this.vault.getHostIdentity(this.settings.hostName);
    const dhKp = generateX25519KeyPair();
    const inviteId = `inv_${randomId(10)}`;
    const inviteSecret = bytesToBase64(randomBytes(32));
    const expiresAt = now + PAIRING_TTL_MS;

    const directUrls =
      this.settings.directEnabled && this.directActualPort
        ? collectLanIpv4Addresses().map((ip) => `ws://${ip}:${this.directActualPort}/ws`)
        : [];
    const relayUrl = !this.settings.directOnly && this.settings.relayUrl ? this.settings.relayUrl.trim() : null;

    const qrPayload = {
      v: 1,
      hostId: identity.hostId,
      hostName: identity.hostName,
      hostDhPub: dhKp.publicKeyB64,
      inviteId,
      inviteSecret,
      directUrls,
      relayUrl,
      routeId: relayUrl ? identity.routeId : null,
      expiresAt,
    };

    this.invites.set(inviteId, {
      inviteId,
      inviteSecret,
      dhKp,
      expiresAt,
      consumed: false,
    });
    this.vault.appendAudit("pairing.invite_created", { inviteId, expiresAt });
    return qrPayload;
  }

  async _handlePairPayload({ deviceId, payload, sendBack, onApprovedBind }) {
    if (!payload || payload.step !== "pair.hello") return;
    const { inviteId, deviceName, clientDhPub, inviteProof } = payload;
    const inv = this.invites.get(inviteId);
    if (!inv || inv.consumed || inv.expiresAt <= Date.now()) {
      sendBack({ step: "pair.rejected", reason: "Pairing invite expired or already used" });
      return;
    }

    const identity = this.vault.getHostIdentity(this.settings.hostName);
    const validProof = await verifyInviteProof(
      {
        inviteSecret: inv.inviteSecret,
        inviteId,
        hostId: identity.hostId,
        deviceId,
        clientDhPubB64: clientDhPub,
      },
      inviteProof
    );
    if (!validProof) {
      this.vault.appendAudit("pairing.invalid_proof", { deviceId, inviteId });
      sendBack({ step: "pair.rejected", reason: "Invalid invite proof" });
      return;
    }

    let derived;
    try {
      const shared = computeSharedSecret(inv.dhKp.privateKey, base64ToBytes(clientDhPub));
      derived = await derivePairingMaterial({
        sharedSecret: shared,
        inviteSecret: inv.inviteSecret,
        inviteId,
        hostId: identity.hostId,
        deviceId,
        hostDhPubB64: inv.dhKp.publicKeyB64,
        clientDhPubB64: clientDhPub,
      });
    } catch (err) {
      sendBack({ step: "pair.rejected", reason: err.message });
      return;
    }

    const pendingId = `pend_${randomId(8)}`;
    this.pendingPairings.set(pendingId, {
      pendingId,
      inviteId,
      deviceId,
      deviceName: String(deviceName || "Mobile Device").slice(0, 64),
      sasCode: derived.sasCode,
      keyId: derived.keyId,
      sessionKeyB64: derived.sessionKeyB64,
      sendBack,
      onApprovedBind,
      createdAt: Date.now(),
      expiresAt: inv.expiresAt,
    });

    sendBack({
      step: "pair.pending_approval",
      pendingId,
      sasCodeHint: "Compare 6-digit code on PI-Desktop and click Approve.",
    });
    this.vault.appendAudit("pairing.awaiting_sas", { pendingId, deviceId, deviceName });
  }

  approvePendingPairing(pendingId, permissions = ["read", "prompt", "abort", "diff", "approve"]) {
    const p = this.pendingPairings.get(pendingId);
    if (!p) throw new Error("Pending pairing request not found or expired");
    const inv = this.invites.get(p.inviteId);
    if (!inv || inv.consumed || inv.expiresAt <= Date.now()) {
      this.pendingPairings.delete(pendingId);
      throw new Error("Pairing invite expired");
    }

    // Atomically consume single-use invite
    inv.consumed = true;
    this.invites.delete(p.inviteId);
    this.pendingPairings.delete(pendingId);

    const record = {
      deviceId: p.deviceId,
      name: p.deviceName,
      keyId: p.keyId,
      sessionKeyB64: p.sessionKeyB64,
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      permissions,
    };
    this.vault.addDevice(record);
    p.onApprovedBind(p.deviceId);
    p.sendBack({
      step: "pair.approved",
      hostId: this.vault.state.hostId,
      hostName: this.vault.getHostIdentity(this.settings.hostName).hostName,
      deviceId: p.deviceId,
      keyId: p.keyId,
      permissions,
    });
    this.vault.appendAudit("pairing.approved", { deviceId: p.deviceId, deviceName: p.deviceName });
    return { ok: true, deviceId: p.deviceId };
  }

  rejectPendingPairing(pendingId) {
    const p = this.pendingPairings.get(pendingId);
    if (!p) return { ok: false };
    this.pendingPairings.delete(pendingId);
    p.sendBack({ step: "pair.rejected", reason: "Rejected by desktop user" });
    this.vault.appendAudit("pairing.rejected", { deviceId: p.deviceId });
    return { ok: true };
  }

  async revokeDevice(deviceId) {
    const existed = this.vault.removeDevice(deviceId);
    const directPeer = this.directPeers.get(deviceId);
    if (directPeer) {
      try {
        directPeer.ws.sendText(JSON.stringify({ t: "error", code: "REVOKED", message: "Device revoked by host" }));
        directPeer.ws.close(4003, "Revoked");
      } catch {
        // ignore
      }
      this.directPeers.delete(deviceId);
    }
    this.relayPeers.delete(deviceId);
    this._sendRelayRevoke(deviceId);
    this.vault.appendAudit("device.revoked", { deviceId, existed });
    return { ok: true, existed };
  }

  async _sendCipherToPeer(deviceId, peer, payload) {
    const dev = this.vault.state.devices[deviceId];
    if (!dev) return false;
    peer.txSeq += 1;
    const envelope = await encryptEnvelope({
      keyBytes: dev.sessionKeyB64,
      keyId: dev.keyId,
      hostId: this.vault.state.hostId,
      deviceId,
      direction: "h2c",
      seq: peer.txSeq,
      payload,
    });
    const wire = JSON.stringify({
      t: "cipher",
      routeId: this.vault.state.routeId,
      deviceId,
      frameId: `f_${randomId(8)}`,
      envelope,
    });
    if (peer.transport === "direct") {
      return peer.ws.sendText(wire);
    }
    if (peer.transport === "relay" && this.relayWs && this.relayWs.readyState === WebSocket.OPEN) {
      this.relayWs.send(wire);
      return true;
    }
    return false;
  }

  _broadcastToAllPeers(payload) {
    for (const [deviceId, peer] of this.directPeers) {
      this._sendCipherToPeer(deviceId, peer, payload).catch(() => {});
    }
    for (const [deviceId, peer] of this.relayPeers) {
      if (this.directPeers.has(deviceId)) continue; // Avoid double delivery when same device is on direct
      this._sendCipherToPeer(deviceId, peer, payload).catch(() => {});
    }
  }

  _emitReplayable(event, payload, sessionId = null) {
    const entry = this.cursorLog.append(event, payload, sessionId);
    this._broadcastToAllPeers(entry);
  }

  _broadcastTransient(event, payload, sessionId = null) {
    this._broadcastToAllPeers({
      type: "evt",
      epoch: this.cursorLog.epoch,
      seq: this.cursorLog.seq,
      transient: true,
      sessionId,
      event,
      payload,
      ts: Date.now(),
    });
  }

  async _handleIncomingCipher(deviceId, envelope, peer) {
    const dev = this.vault.state.devices[deviceId];
    if (!dev) return;

    let msg;
    try {
      msg = await decryptEnvelope({
        keyBytes: dev.sessionKeyB64,
        keyId: dev.keyId,
        hostId: this.vault.state.hostId,
        deviceId,
        expectedDirection: "c2h",
        envelope,
        replayWindow: peer.replayWindow,
      });
    } catch (err) {
      this.vault.appendAudit("cipher.auth_failed", { deviceId, error: err.message });
      return;
    }

    const check = validateRpcRequest(msg);
    if (!check.ok) {
      await this._sendCipherToPeer(deviceId, peer, {
        type: "res",
        id: msg?.id || "unknown",
        ok: false,
        error: { code: "BAD_REQUEST", message: check.error },
      });
      return;
    }

    try {
      const { result } = await this.idempotency.checkOrRun({
        deviceId,
        idempotencyKey: msg.idempotencyKey,
        method: msg.method,
        params: msg.params,
        execute: () => this._dispatchRpc(deviceId, msg.method, msg.params || {}),
      });
      await this._sendCipherToPeer(deviceId, peer, {
        type: "res",
        id: msg.id,
        ok: true,
        result,
      });
    } catch (err) {
      await this._sendCipherToPeer(deviceId, peer, {
        type: "res",
        id: msg.id,
        ok: false,
        error: { code: err.code || "INTERNAL_ERROR", message: err.message || "RPC failed" },
      });
    }
  }

  async _ensureAuthorizedProject(projectPath) {
    const projects = await this.hostAdapter.listProjects(this.vault.state.allowedProjects);
    const resolvedTarget = path.resolve(projectPath).toLowerCase();
    const match = projects.find((p) => path.resolve(p.path).toLowerCase() === resolvedTarget);
    if (!match) {
      const err = new Error("Project is not in authorized remote scope");
      err.code = "FORBIDDEN_PROJECT";
      throw err;
    }
    return match.path;
  }

  _mergeSessionWorkState(sessionId, hostTodos, hostTasks) {
    const live = this._liveWorkState.get(sessionId);
    const tasks = new Map();
    for (const task of hostTasks || []) tasks.set(task.id, task);
    if (live) {
      for (const task of live.tasks.values()) {
        tasks.set(task.id, { ...tasks.get(task.id), ...task });
      }
    }
    return { todos: live?.todos.length ? live.todos : hostTodos || [], backgroundTasks: Array.from(tasks.values()) };
  }

  async _dispatchRpc(deviceId, method, params) {
    this.vault.appendAudit(`rpc.${method}`, { deviceId, sessionId: params.sessionId || null });

    switch (method) {
      case "host.info": {
        const identity = this.vault.getHostIdentity(this.settings.hostName);
        const capabilityMode = await this.hostAdapter.detectCapabilityMode();
        const projects = await this.hostAdapter.listProjects(this.vault.state.allowedProjects);
        return {
          hostId: identity.hostId,
          hostName: identity.hostName,
          pluginVersion: PLUGIN_VERSION,
          capabilityMode,
          epoch: this.cursorLog.epoch,
          currentSeq: this.cursorLog.seq,
          projects,
        };
      }
      case "project.list": {
        const projects = await this.hostAdapter.listProjects(this.vault.state.allowedProjects);
        return { projects };
      }
      case "session.list": {
        let projectPath = params.projectPath || null;
        if (projectPath) projectPath = await this._ensureAuthorizedProject(projectPath);
        const sessions = await this.hostAdapter.listSessions({ projectPath });
        return { sessions, epoch: this.cursorLog.epoch, currentSeq: this.cursorLog.seq };
      }
      case "session.get": {
        if (!params.sessionId) throw new Error("Missing sessionId");
        const sid = String(params.sessionId);
        const data = await this.hostAdapter.getSession({
          sessionId: sid,
          messageLimit: Math.min(200, Number(params.messageLimit) || 80),
        });
        return {
          ...data,
          ...this._mergeSessionWorkState(sid, data.todos, data.backgroundTasks),
          epoch: this.cursorLog.epoch,
          currentSeq: this.cursorLog.seq,
        };
      }
      case "session.create": {
        const projectPath = await this._ensureAuthorizedProject(String(params.projectPath || ""));
        return this.hostAdapter.createSession({
          projectPath,
          title: params.title ? String(params.title).slice(0, 120) : undefined,
          mode: params.mode === "plan" || params.mode === "goal" ? params.mode : "agent",
          providerId: params.providerId ? String(params.providerId) : undefined,
          modelId: params.modelId ? String(params.modelId) : undefined,
          thinkingLevel: params.thinkingLevel ? String(params.thinkingLevel) : undefined,
        });
      }
      case "session.open": {
        if (!params.sessionId) throw new Error("Missing sessionId");
        await this.hostAdapter.openSession({ sessionId: String(params.sessionId) });
        return { ok: true };
      }
      case "session.configure": {
        if (!params.sessionId) throw new Error("Missing sessionId");
        const sid = String(params.sessionId);
        const res = await this.hostAdapter.configureSession({
          sessionId: sid,
          mode: params.mode,
          permissionMode: params.permissionMode,
          providerId: params.providerId,
          modelId: params.modelId,
          thinkingLevel: params.thinkingLevel,
          fastMode: params.fastMode,
        });
        if (res.applied && res.session) {
          this._emitReplayable("session.configured", { sessionId: sid, session: res.session }, sid);
        }
        return res;
      }
      case "providers.list": {
        return this.hostAdapter.listProviders();
      }
      case "providers.refreshCatalog": {
        return this.hostAdapter.refreshModelCatalog();
      }
      case "settings.get": {
        return this.hostAdapter.getHostSettings();
      }
      case "tasks.list": {
        const sid = params.sessionId ? String(params.sessionId) : null;
        const scheduledTasks = await this.hostAdapter.listScheduledTasks();
        let todos = [];
        let backgroundTasks;

        if (sid) {
          let detail;
          try {
            detail = await this.hostAdapter.getSession({ sessionId: sid, messageLimit: 120 });
          } catch {
            // fallback to live state
          }
          ({ todos, backgroundTasks } = this._mergeSessionWorkState(sid, detail?.todos, detail?.backgroundTasks));
        } else {
          const mergedTasksMap = new Map();
          for (const live of this._liveWorkState.values()) {
            for (const t of live.tasks.values()) mergedTasksMap.set(t.id, t);
          }
          backgroundTasks = Array.from(mergedTasksMap.values());
        }

        return {
          sessionId: sid,
          todos,
          backgroundTasks: backgroundTasks.sort((a, b) =>
            String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
          ),
          scheduledTasks,
          updatedAt: new Date().toISOString(),
        };
      }
      case "turn.start": {
        if (!params.sessionId || !params.content) throw new Error("Missing sessionId or content");
        const res = await this.hostAdapter.startTurn({
          sessionId: String(params.sessionId),
          content: String(params.content),
        });
        this._emitReplayable(
          "turn.state",
          { sessionId: String(params.sessionId), turnId: res?.turnId || null, status: "running" },
          String(params.sessionId)
        );
        return res || { accepted: true };
      }
      case "turn.abort": {
        if (!params.sessionId) throw new Error("Missing sessionId");
        const res = await this.hostAdapter.abortTurn({
          sessionId: String(params.sessionId),
          turnId: params.turnId ? String(params.turnId) : null,
        });
        this._emitReplayable(
          "turn.state",
          { sessionId: String(params.sessionId), turnId: params.turnId || null, status: "aborted" },
          String(params.sessionId)
        );
        return res || { aborted: true };
      }
      case "pending.list": {
        return this.hostAdapter.getPendingItems(Array.isArray(params.sessionIds) ? params.sessionIds : []);
      }
      case "approval.resolve": {
        if (!params.approvalId || !params.sessionId || !params.decision) {
          throw new Error("Missing approvalId, sessionId, or decision");
        }
        // High-risk policy: only allow "once" remotely unless explicitly non-high-risk
        const scope = params.risk === "high" ? "once" : params.scope || "once";
        return this.hostAdapter.resolvePermission({
          approvalId: String(params.approvalId),
          sessionId: String(params.sessionId),
          decision: String(params.decision),
          scope,
        });
      }
      case "ask.resolve": {
        if (!params.askId || !params.sessionId) throw new Error("Missing askId or sessionId");
        return this.hostAdapter.resolveAsk({
          askId: String(params.askId),
          sessionId: String(params.sessionId),
          answers: params.answers || {},
        });
      }
      case "plan.resolve": {
        if (!params.proposalId || !params.sessionId || !params.action) {
          throw new Error("Missing proposalId, sessionId, or action");
        }
        return this.hostAdapter.resolvePlan({
          proposalId: String(params.proposalId),
          sessionId: String(params.sessionId),
          turnId: params.turnId,
          toolCallId: params.toolCallId,
          action: params.action === "approve" ? "approve" : "reject",
          targetPermissionMode: params.targetPermissionMode,
        });
      }
      case "diff.summary": {
        const projectPath = await this._ensureAuthorizedProject(String(params.projectPath || ""));
        return getGitDiffSummary(projectPath);
      }
      case "diff.file": {
        const projectPath = await this._ensureAuthorizedProject(String(params.projectPath || ""));
        if (!params.filePath) throw new Error("Missing filePath");
        return getGitFilePatch(projectPath, String(params.filePath));
      }
      case "sync.pull": {
        return this.cursorLog.pull({
          epoch: params.epoch,
          afterSeq: Number(params.afterSeq) || 0,
          limit: Math.min(500, Number(params.limit) || 200),
          sessionId: params.sessionId || null,
        });
      }
      default:
        throw new Error(`Unsupported method: ${method}`);
    }
  }

  _startPendingPoller() {
    if (this.pendingPollTimer) clearInterval(this.pendingPollTimer);
    this.pendingPollTimer = setInterval(async () => {
      if (this.directPeers.size === 0 && this.relayPeers.size === 0) return;
      try {
        const res = await this.hostAdapter.getPendingItems();
        const digest = JSON.stringify(res.items.map((i) => `${i.id}:${i.kind}:${i.sessionId}`));
        if (digest !== this._lastPendingDigest) {
          this._lastPendingDigest = digest;
          this._emitReplayable("pending.updated", res);
        }
      } catch {
        // host busy or unavailable
      }
    }, 1500);
  }

  async getConsoleSnapshot() {
    const identity = this.vault.getHostIdentity(this.settings.hostName);
    const capabilityMode = await this.hostAdapter.detectCapabilityMode();
    const allProjects = await this.hostAdapter.listProjects([]);
    this._pruneExpiredPairings(Date.now());
    const pendingPairings = Array.from(this.pendingPairings.values(), (p) => ({
      pendingId: p.pendingId,
      deviceId: p.deviceId,
      deviceName: p.deviceName,
      sasCode: p.sasCode,
      expiresAt: p.expiresAt,
    }));

    return {
      hostId: identity.hostId,
      hostName: identity.hostName,
      routeId: identity.routeId,
      capabilityMode,
      directEnabled: Boolean(this.settings.directEnabled),
      directPort: this.directActualPort,
      directUrls:
        this.settings.directEnabled && this.directActualPort
          ? collectLanIpv4Addresses().map((ip) => `ws://${ip}:${this.directActualPort}/ws`)
          : [],
      directOnly: Boolean(this.settings.directOnly),
      relayUrl: this.settings.relayUrl || "",
      relayStatus: this.relayStatus,
      onlineDeviceIds: Array.from(new Set([...this.directPeers.keys(), ...this.relayPeers.keys()])),
      devices: this.vault.listDevicesPublic(),
      pendingPairings,
      projects: allProjects,
      allowedProjects: this.vault.state.allowedProjects,
      recentAudit: this.vault.readRecentAudit(30),
    };
  }
}
