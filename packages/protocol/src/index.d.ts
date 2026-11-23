export type CapabilityMode = "standard" | "mcp-full";

export interface PairingInvite {
  v: 1;
  hostId: string;
  hostName: string;
  hostDhPub: string;
  inviteId: string;
  inviteSecret: string;
  directUrls: string[];
  relayUrl?: string | null;
  routeId?: string | null;
  expiresAt: number;
}

export interface CipherEnvelope {
  v: 1;
  alg: "X25519-HKDF-SHA256-AES256GCM";
  kid: string;
  dir: "h2c" | "c2h";
  seq: number;
  iv: string;
  ct: string;
  tag: string;
}

export interface RpcRequest {
  type: "req";
  id: string;
  idempotencyKey?: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  type: "res";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface RemoteEvent {
  type: "evt";
  epoch: string;
  seq: number;
  transient: boolean;
  sessionId?: string | null;
  event: string;
  payload: Record<string, unknown>;
  ts: number;
}

export interface HostInfo {
  hostId: string;
  hostName: string;
  pluginVersion: string;
  capabilityMode: CapabilityMode;
  epoch: string;
  currentSeq: number;
  projects: ProjectEntry[];
}

export interface ProjectEntry {
  path: string;
  name: string;
  active?: boolean;
}

export type SessionMode = "agent" | "goal" | "plan";
export type PermissionMode = "inherit" | "ask" | "accept-edits" | "auto";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "omit";

export interface SessionSummary {
  id: string;
  title: string;
  projectPath: string;
  status: "idle" | "running" | "waiting_approval" | "waiting_input" | "error";
  updatedAt: string;
  mode?: SessionMode;
  permissionMode?: PermissionMode;
  providerId?: string;
  modelId?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  fastMode?: boolean;
  activeTurnId?: string | null;
}

export interface ProviderModelEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  vision?: boolean;
  enabled?: boolean;
}

export interface ProviderSummary {
  id: string;
  name: string;
  vendorKey?: string;
  baseUrl?: string;
  apiStyle?: string;
  enabled: boolean;
  hasApiKey: boolean;
  defaultModelId?: string;
  models: ProviderModelEntry[];
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "high" | "medium" | "low";
}

export interface BackgroundTaskItem {
  id: string;
  kind: "bash" | "subagent" | "task";
  title: string;
  command?: string;
  agent?: string;
  sessionId?: string;
  state: "running" | "exited" | "completed" | "failed" | "stopped";
  exitCode?: number | null;
  outputPreview?: string;
  startedAt?: string;
  updatedAt?: string;
}

export interface ScheduledTaskItem {
  id: string;
  title: string;
  prompt?: string;
  cadence?: string;
  enabled: boolean;
  projectPath?: string;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastStatus?: string | null;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  thinking?: string;
  createdAt: string;
  toolName?: string;
  toolStatus?: "running" | "success" | "error";
  toolArgsPreview?: string;
  toolResultPreview?: string;
  isProcessStep?: boolean;
  streaming?: boolean;
}

export interface PendingApprovalItem {
  id: string;
  kind: "permission" | "ask" | "plan";
  sessionId: string;
  sessionTitle?: string;
  turnId?: string;
  toolCallId?: string;
  risk: "low" | "medium" | "high";
  title: string;
  summary: string;
  argsPreview?: string;
  options?: Array<{ label: string; description?: string }>;
  requiresDesktopConfirm: boolean;
  createdAt: string;
}

export interface DiffFileSummary {
  path: string;
  status: "A" | "M" | "D" | "R" | "U" | "?";
  additions: number;
  deletions: number;
  staged: boolean;
}

export interface DiffHunkLine {
  type: "context" | "add" | "del";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffHunkLine[];
}

export interface DiffFilePatch {
  path: string;
  status: string;
  truncated: boolean;
  binary: boolean;
  hunks: DiffHunk[];
}

export declare function generateX25519KeyPair(cryptoImpl?: Crypto): {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  privateKeyB64: string;
  publicKeyB64: string;
};
export declare function computeSharedSecret(privateKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array;
export declare function computeInviteProof(
  params: { inviteSecret: string | Uint8Array; inviteId: string; hostId: string; deviceId: string; clientDhPubB64: string },
  cryptoImpl?: Crypto
): Promise<string>;
export declare function verifyInviteProof(
  params: { inviteSecret: string | Uint8Array; inviteId: string; hostId: string; deviceId: string; clientDhPubB64: string },
  expectedProofB64: string,
  cryptoImpl?: Crypto
): Promise<boolean>;
export declare function derivePairingMaterial(
  params: {
    sharedSecret: Uint8Array;
    inviteSecret: string | Uint8Array;
    inviteId: string;
    hostId: string;
    deviceId: string;
    hostDhPubB64: string;
    clientDhPubB64: string;
  },
  cryptoImpl?: Crypto
): Promise<{ sessionKey: Uint8Array; sessionKeyB64: string; keyId: string; sasCode: string }>;
export declare function encryptEnvelope(
  params: {
    keyBytes: Uint8Array | string;
    keyId: string;
    hostId: string;
    deviceId: string;
    direction: "h2c" | "c2h";
    seq: number;
    payload: unknown;
  },
  cryptoImpl?: Crypto
): Promise<CipherEnvelope>;
export declare function decryptEnvelope(
  params: {
    keyBytes: Uint8Array | string;
    keyId?: string;
    hostId: string;
    deviceId: string;
    expectedDirection: "h2c" | "c2h";
    envelope: CipherEnvelope;
    replayWindow?: ReplayWindow;
  },
  cryptoImpl?: Crypto
): Promise<unknown>;
export declare function sha256Hex(input: string | Uint8Array, cryptoImpl?: Crypto): Promise<string>;
export declare function randomId(byteLen?: number, cryptoImpl?: Crypto): string;
export declare function bytesToBase64(bytes: Uint8Array): string;
export declare function base64ToBytes(b64: string): Uint8Array;
export declare function validatePairingInvite(invite: unknown, nowMs?: number): { ok: boolean; error?: string };
export declare function validateRpcRequest(msg: unknown): { ok: boolean; error?: string };
export declare function isDeniedCredentialPath(relPath: string): boolean;
export declare function isAllowedWsUrl(rawUrl: string, allowPrivatePlaintext?: boolean): boolean;
export declare function redactSecrets(input: string): string;

export declare class ReplayWindow {
  constructor(windowSize?: number);
  canAccept(seq: number): boolean;
  record(seq: number): void;
}

export declare class EventCursorLog {
  epoch: string;
  seq: number;
  constructor(opts?: { epoch?: string; maxEvents?: number });
  append(event: string, payload: Record<string, unknown>, sessionId?: string | null): RemoteEvent;
  pull(opts?: { epoch?: string; afterSeq?: number; limit?: number; sessionId?: string | null }): {
    epoch: string;
    currentSeq: number;
    needsSnapshot: boolean;
    hasMore?: boolean;
    events: RemoteEvent[];
  };
}

export declare class StreamDeltaCoalescer {
  constructor(opts: { flushIntervalMs?: number; maxChunkBytes?: number; onFlush: (chunk: { sessionId: string; turnId: string | null; channel: string; delta: string }) => void });
  push(opts: { sessionId: string; turnId?: string | null; channel?: string; delta: string }): void;
  flush(): void;
  dispose(): void;
}

export declare class IdempotencyStore {
  constructor(opts?: { maxEntries?: number; ttlMs?: number });
  checkOrRun<T>(opts: { deviceId: string; idempotencyKey?: string; method: string; params?: Record<string, unknown>; execute: () => Promise<T> }): Promise<{ replayed: boolean; result: T }>;
}
