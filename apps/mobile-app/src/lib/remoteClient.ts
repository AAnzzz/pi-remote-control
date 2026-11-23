/**
 * Companion Mobile E2EE Remote Client (`pi-remote.v1`).
 * - Hybrid transport: races LAN/Tailscale directUrls first; falls back to Blind WSS Relay after 750ms.
 * - Full X25519 + HKDF-SHA256 + AES-256-GCM pairing (with 6-digit SAS display) and encrypted RPC.
 * - Cursor-based resume (`sync.pull`) + idempotent command dispatch (`idempotencyKey`).
 */

import "./rnCrypto";
import {
  generateX25519KeyPair,
  computeSharedSecret,
  computeInviteProof,
  derivePairingMaterial,
  encryptEnvelope,
  decryptEnvelope,
  ReplayWindow,
  base64ToBytes,
  randomId,
  validatePairingInvite,
  type PairingInvite,
  type HostInfo,
  type SessionSummary,
  type ChatMessage,
  type PendingApprovalItem,
  type DiffFileSummary,
  type DiffFilePatch,
  type RemoteEvent,
  type SessionMode,
  type PermissionMode,
  type ThinkingLevel,
  type ProviderSummary,
  type TodoItem,
  type BackgroundTaskItem,
  type ScheduledTaskItem,
} from "@pi-remote/protocol";

export interface PairedHostRecord {
  hostId: string;
  hostName: string;
  deviceId: string;
  keyId: string;
  sessionKeyB64: string;
  directUrls: string[];
  relayUrl?: string | null;
  routeId?: string | null;
  directOnly?: boolean;
  lastEpoch?: string;
  lastSeq?: number;
}

export interface HostSettingsSummary {
  defaultMode: SessionMode;
  defaultPermissionMode: PermissionMode;
  defaultProviderId: string;
  defaultModelId: string;
  defaultThinkingLevel: ThinkingLevel;
  scheduledTasksEnabled?: boolean;
  locale?: string;
}

export interface SessionConfigureParams {
  sessionId: string;
  mode?: SessionMode;
  permissionMode?: PermissionMode;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  fastMode?: boolean;
}

export interface SessionConfigureResult {
  applied: boolean;
  requiresDesktopConfirm: boolean;
  capabilityMode?: string;
  session?: SessionSummary | null;
  message?: string;
}

export interface TasksSnapshot {
  sessionId: string | null;
  todos: TodoItem[];
  backgroundTasks: BackgroundTaskItem[];
  scheduledTasks: ScheduledTaskItem[];
  updatedAt: string;
}

type ResolutionResult = { resolved: boolean; requiresDesktopConfirm: boolean; message?: string; result?: unknown };

export type ConnectionState =
  | "offline"
  | "probing"
  | "pairing_sas"
  | "online_direct"
  | "online_relay"
  | "revoked"
  | "error";

export interface ClientCallbacks {
  onStateChange?: (state: ConnectionState, detail?: string) => void;
  onEvent?: (evt: RemoteEvent) => void;
  onSasReady?: (sasCode: string, hostName: string) => void;
  onPaired?: (record: PairedHostRecord) => void;
}

function openWsWithTimeout(url: string, timeoutMs = 3500): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error(`Timeout connecting ${url}`));
    }, timeoutMs);

    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed connecting ${url}`));
    };
  });
}

export class PiRemoteClient {
  private ws: WebSocket | null = null;
  private host: PairedHostRecord | null = null;
  private state: ConnectionState = "offline";
  private callbacks: ClientCallbacks;
  private txSeq = 0;
  private replayWindow = new ReplayWindow();
  private pendingRpc = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private transportKind: "direct" | "relay" = "direct";

  constructor(callbacks: ClientCallbacks = {}) {
    this.callbacks = callbacks;
  }

  getState(): ConnectionState {
    return this.state;
  }

  getHost(): PairedHostRecord | null {
    return this.host;
  }

  private setState(next: ConnectionState, detail?: string) {
    this.state = next;
    this.callbacks.onStateChange?.(next, detail);
  }

  disconnect() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const [id, entry] of this.pendingRpc) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Connection closed"));
      this.pendingRpc.delete(id);
    }
    if (this.ws) {
      try {
        this.ws.close(1000, "Client disconnect");
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.setState("offline");
  }

  /**
   * Hybrid path race: try LAN/Tailscale directUrls first; if not connected within 750ms
   * and directOnly is false, race relayUrl as well. First authenticated path wins.
   */
  private async connectBestTransport(
    directUrls: string[],
    relayUrl?: string | null,
    directOnly = false
  ): Promise<{ ws: WebSocket; kind: "direct" | "relay" }> {
    const candidates = [...(directUrls || [])];
    if (candidates.length === 0 && !directOnly && relayUrl) {
      const ws = await openWsWithTimeout(relayUrl, 5000);
      return { ws, kind: "relay" };
    }

    return new Promise((resolve, reject) => {
      let done = false;
      const openSockets: WebSocket[] = [];
      let pendingAttempts = 0;
      let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

      const finish = (ws: WebSocket, kind: "direct" | "relay") => {
        if (done) {
          try {
            ws.close();
          } catch {
            // ignore
          }
          return;
        }
        done = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        for (const s of openSockets) {
          if (s !== ws) {
            try {
              s.close();
            } catch {
              // ignore
            }
          }
        }
        resolve({ ws, kind });
      };

      const checkAllFailed = () => {
        if (!done && pendingAttempts === 0 && !fallbackTimer) {
          done = true;
          reject(new Error("Unable to reach host over LAN or Relay"));
        }
      };

      const launch = (url: string, kind: "direct" | "relay") => {
        pendingAttempts += 1;
        openWsWithTimeout(url, kind === "direct" ? 2500 : 5000)
          .then((ws) => {
            openSockets.push(ws);
            finish(ws, kind);
          })
          .catch(() => {
            pendingAttempts -= 1;
            checkAllFailed();
          });
      };

      for (const u of candidates) launch(u, "direct");

      if (!directOnly && relayUrl) {
        fallbackTimer = setTimeout(() => {
          fallbackTimer = null;
          if (!done) launch(relayUrl, "relay");
        }, 750);
      }
    });
  }

  /**
   * Pair with a PI-Desktop host using a scanned/pasted 120s PairingInvite.
   * Displays the 6-digit SAS code via `onSasReady` and resolves once desktop user clicks Approve.
   */
  async pairWithInvite(invite: PairingInvite, deviceName = "Mobile App"): Promise<PairedHostRecord> {
    const check = validatePairingInvite(invite);
    if (!check.ok) {
      throw new Error(check.error || "Invalid pairing invite");
    }

    this.disconnect();
    this.setState("probing", "Connecting to desktop...");

    const { ws, kind } = await this.connectBestTransport(invite.directUrls || [], invite.relayUrl, false);
    this.ws = ws;
    this.transportKind = kind;

    const deviceId = `dev_${randomId(10)}`;
    const clientKp = generateX25519KeyPair();
    const inviteProof = await computeInviteProof({
      inviteSecret: invite.inviteSecret,
      inviteId: invite.inviteId,
      hostId: invite.hostId,
      deviceId,
      clientDhPubB64: clientKp.publicKeyB64,
    });

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

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.disconnect();
        reject(new Error("Pairing timed out waiting for desktop approval"));
      }, 125_000);

      ws.onmessage = (evt) => {
        let frame: any;
        try {
          frame = JSON.parse(String(evt.data));
        } catch {
          return;
        }

        if (frame.t === "client.joined") {
          ws.send(
            JSON.stringify({
              t: "pair",
              routeId: invite.routeId || "direct",
              deviceId,
              payload: {
                step: "pair.hello",
                inviteId: invite.inviteId,
                deviceName,
                clientDhPub: clientKp.publicKeyB64,
                inviteProof,
              },
            })
          );
          return;
        }

        if (frame.t === "pair" && frame.payload?.step === "pair.pending_approval") {
          this.setState("pairing_sas", derived.sasCode);
          this.callbacks.onSasReady?.(derived.sasCode, invite.hostName);
          return;
        }

        if (frame.t === "pair" && frame.payload?.step === "pair.approved") {
          clearTimeout(timeout);
          const record: PairedHostRecord = {
            hostId: invite.hostId,
            hostName: frame.payload.hostName || invite.hostName,
            deviceId,
            keyId: derived.keyId,
            sessionKeyB64: derived.sessionKeyB64,
            directUrls: invite.directUrls || [],
            relayUrl: invite.relayUrl || null,
            routeId: invite.routeId || null,
          };
          this.host = record;
          this.txSeq = 0;
          this.replayWindow = new ReplayWindow();
          this.attachAuthenticatedHandlers(ws);
          this.setState(kind === "direct" ? "online_direct" : "online_relay");
          this.callbacks.onPaired?.(record);
          resolve(record);
          return;
        }

        if (frame.t === "pair" && frame.payload?.step === "pair.rejected") {
          clearTimeout(timeout);
          this.disconnect();
          reject(new Error(frame.payload.reason || "Pairing rejected by desktop"));
          return;
        }

        if (frame.t === "error") {
          clearTimeout(timeout);
          this.disconnect();
          reject(new Error(frame.message || frame.code || "Pairing transport error"));
        }
      };

      ws.send(
        JSON.stringify({
          t: "client.join",
          routeId: invite.routeId || "direct",
          deviceId,
        })
      );
    });
  }

  /**
   * Reconnect to an already paired host using stored credentials.
   */
  async connectPairedHost(record: PairedHostRecord): Promise<void> {
    this.disconnect();
    this.host = record;
    this.txSeq = 0;
    this.replayWindow = new ReplayWindow();
    this.setState("probing", "Connecting...");

    const { ws, kind } = await this.connectBestTransport(
      record.directUrls,
      record.relayUrl,
      Boolean(record.directOnly)
    );
    this.ws = ws;
    this.transportKind = kind;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Join handshake timed out")), 5000);
      ws.onmessage = (evt) => {
        let frame: any;
        try {
          frame = JSON.parse(String(evt.data));
        } catch {
          return;
        }
        if (frame.t === "client.joined") {
          clearTimeout(timer);
          this.attachAuthenticatedHandlers(ws);
          this.setState(kind === "direct" ? "online_direct" : "online_relay");
          resolve();
        } else if (frame.t === "error") {
          clearTimeout(timer);
          if (frame.code === "REVOKED") this.setState("revoked");
          reject(new Error(frame.message || frame.code));
        }
      };
      ws.send(
        JSON.stringify({
          t: "client.join",
          routeId: record.routeId || "direct",
          deviceId: record.deviceId,
        })
      );
    });
  }

  private attachAuthenticatedHandlers(ws: WebSocket) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.ws === ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "ping", ts: Date.now() }));
      }
    }, 25_000);

    ws.onmessage = async (evt) => {
      if (this.ws !== ws || !this.host) return;
      let frame: any;
      try {
        frame = JSON.parse(String(evt.data));
      } catch {
        return;
      }

      if (frame.t === "error" && frame.code === "REVOKED") {
        this.setState("revoked", "This device was revoked on PI-Desktop.");
        this.disconnect();
        return;
      }

      if (frame.t === "peer.left" && frame.role === "host") {
        this.setState("offline", "Desktop host went offline");
        return;
      }

      if (frame.t !== "cipher") return;
      let decoded: any;
      try {
        decoded = await decryptEnvelope({
          keyBytes: this.host.sessionKeyB64,
          keyId: this.host.keyId,
          hostId: this.host.hostId,
          deviceId: this.host.deviceId,
          expectedDirection: "h2c",
          envelope: frame.envelope,
          replayWindow: this.replayWindow,
        });
      } catch {
        return;
      }

      if (decoded.type === "res" && decoded.id) {
        const pending = this.pendingRpc.get(decoded.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRpc.delete(decoded.id);
          if (decoded.ok) pending.resolve(decoded.result);
          else pending.reject(new Error(decoded.error?.message || decoded.error?.code || "RPC failed"));
        }
        return;
      }

      if (decoded.type === "evt") {
        if (!decoded.transient && typeof decoded.seq === "number" && this.host) {
          this.host.lastEpoch = decoded.epoch;
          this.host.lastSeq = decoded.seq;
        }
        this.callbacks.onEvent?.(decoded as RemoteEvent);
      }
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      if (ev.code === 4003) {
        this.setState("revoked", "Device revoked by desktop host");
      } else if (this.state !== "revoked") {
        this.setState("offline", "Disconnected");
      }
    };
  }

  async call<T = any>(method: string, params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.host) {
      throw new Error("Host is offline");
    }
    this.txSeq += 1;
    const id = `rpc_${this.txSeq}_${randomId(4)}`;
    const envelope = await encryptEnvelope({
      keyBytes: this.host.sessionKeyB64,
      keyId: this.host.keyId,
      hostId: this.host.hostId,
      deviceId: this.host.deviceId,
      direction: "c2h",
      seq: this.txSeq,
      payload: {
        type: "req",
        id,
        idempotencyKey,
        method,
        params,
      },
    });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 20_000);
      this.pendingRpc.set(id, { resolve, reject, timer });

      this.ws!.send(
        JSON.stringify({
          t: "cipher",
          routeId: this.host!.routeId || "direct",
          deviceId: this.host!.deviceId,
          frameId: id,
          envelope,
        })
      );
    });
  }

  // Typed high-level domain helpers
  getHostInfo() {
    return this.call<HostInfo>("host.info");
  }
  listSessions(projectPath?: string) {
    return this.call<{ sessions: SessionSummary[]; epoch: string; currentSeq: number }>(
      "session.list",
      projectPath ? { projectPath } : {}
    );
  }
  getSession(sessionId: string) {
    return this.call<{
      session: SessionSummary;
      messages: ChatMessage[];
      todos?: TodoItem[];
      backgroundTasks?: BackgroundTaskItem[];
      epoch: string;
      currentSeq: number;
    }>(
      "session.get",
      { sessionId }
    );
  }
  createSession(projectPath: string, title?: string, opts?: {
    mode?: SessionMode; providerId?: string; modelId?: string; thinkingLevel?: ThinkingLevel;
  }) {
    return this.call<SessionSummary>("session.create", { projectPath, title, ...opts }, `create_${randomId(8)}`);
  }
  configureSession(params: SessionConfigureParams) {
    return this.call<SessionConfigureResult>("session.configure", { ...params });
  }
  listProviders() {
    return this.call<{ providers: ProviderSummary[] }>("providers.list");
  }
  refreshModelCatalog() {
    return this.call<{ providers: ProviderSummary[] }>("providers.refreshCatalog");
  }
  getHostSettings() {
    return this.call<HostSettingsSummary>("settings.get");
  }
  listTasks(sessionId?: string) {
    return this.call<TasksSnapshot>("tasks.list", sessionId ? { sessionId } : {});
  }
  resolveAsk(askId: string, sessionId: string, answers: Record<string, unknown>) {
    return this.call<ResolutionResult>("ask.resolve", { askId, sessionId, answers });
  }
  resolvePlan(params: {
    proposalId: string; sessionId: string; turnId?: string; toolCallId?: string;
    action: "approve" | "reject"; targetPermissionMode?: string;
  }) {
    return this.call<ResolutionResult>("plan.resolve", params);
  }
  startTurn(sessionId: string, content: string, idempotencyKey = `turn_${randomId(8)}`) {
    return this.call<{ accepted: boolean; turnId?: string }>(
      "turn.start",
      { sessionId, content },
      idempotencyKey
    );
  }
  abortTurn(sessionId: string, turnId?: string | null) {
    return this.call<{ aborted: boolean }>("turn.abort", { sessionId, turnId: turnId || undefined });
  }
  listPending() {
    return this.call<{ capabilityMode: "standard" | "mcp-full"; items: PendingApprovalItem[] }>("pending.list");
  }
  resolveApproval(item: PendingApprovalItem, decision: "allow" | "deny", scope: "once" | "session" = "once") {
    return this.call<{ resolved: boolean; requiresDesktopConfirm: boolean; message?: string }>(
      "approval.resolve",
      {
        approvalId: item.id,
        sessionId: item.sessionId,
        decision,
        risk: item.risk,
        scope: item.risk === "high" ? "once" : scope,
      }
    );
  }
  getDiffSummary(projectPath: string) {
    return this.call<{ isRepo: boolean; branch: string; files: DiffFileSummary[] }>("diff.summary", { projectPath });
  }
  getDiffFile(projectPath: string, filePath: string) {
    return this.call<DiffFilePatch>("diff.file", { projectPath, filePath });
  }
  pullSync(epoch?: string, afterSeq = 0) {
    return this.call<{ epoch: string; currentSeq: number; needsSnapshot: boolean; events: RemoteEvent[] }>(
      "sync.pull",
      { epoch, afterSeq }
    );
  }
}
