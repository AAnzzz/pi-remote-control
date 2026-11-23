/**
 * Zero-eval runtime validators & security boundary helpers for pi-remote.v1.
 * No eval, no new Function, safe for PI-Desktop SEC003 static audit.
 */

export const MAX_FRAME_BYTES = 262_144; // 256 KiB
export const PAIRING_TTL_MS = 120_000; // 2 minutes
export const ROUTE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const SAFE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const HEX_64_RE = /^[0-9a-f]{64}$/i;

export const CREDENTIAL_DENY_PATTERNS = [
  /(^|[\\/])\.env($|\.)/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.git([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|[\\/])id_(rsa|ed25519|ecdsa)(\.pub)?$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])secrets\.json$/i,
  /(^|[\\/])\.machine-key$/i,
];

export const VALID_SESSION_MODES = new Set(["agent", "goal", "plan"]);
export const VALID_PERMISSION_MODES = new Set(["inherit", "ask", "accept-edits", "auto"]);
export const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "omit"]);

export const ALLOWED_RPC_METHODS = new Set([
  "host.info",
  "project.list",
  "session.list",
  "session.get",
  "session.create",
  "session.open",
  "session.configure",
  "turn.start",
  "turn.abort",
  "pending.list",
  "approval.resolve",
  "ask.resolve",
  "plan.resolve",
  "diff.summary",
  "diff.file",
  "providers.list",
  "providers.refreshCatalog",
  "settings.get",
  "tasks.list",
  "sync.pull",
]);

export function isNonEmptyString(v, maxLen = 4096) {
  return typeof v === "string" && v.length > 0 && v.length <= maxLen;
}

export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Returns true if a relative or normalized path targets credential/secret files that must NEVER be exposed remotely.
 */
export function isDeniedCredentialPath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) return true;
  if (relPath.includes("\0")) return true;
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/");
  if (segments.some((s) => s === "..")) return true;
  return CREDENTIAL_DENY_PATTERNS.some((re) => re.test(normalized));
}

export function validatePairingInvite(invite, nowMs = Date.now()) {
  if (!isPlainObject(invite)) return { ok: false, error: "Invite must be an object" };
  if (invite.v !== 1) return { ok: false, error: "Unsupported invite version" };
  if (!isNonEmptyString(invite.hostId, 128) || !SAFE_ID_RE.test(invite.hostId)) {
    return { ok: false, error: "Invalid hostId" };
  }
  if (!isNonEmptyString(invite.hostName, 128)) {
    return { ok: false, error: "Invalid hostName" };
  }
  if (!isNonEmptyString(invite.inviteId, 128) || !SAFE_ID_RE.test(invite.inviteId)) {
    return { ok: false, error: "Invalid inviteId" };
  }
  if (!isNonEmptyString(invite.inviteSecret, 128)) {
    return { ok: false, error: "Missing inviteSecret" };
  }
  if (!isNonEmptyString(invite.hostDhPub, 128)) {
    return { ok: false, error: "Missing hostDhPub" };
  }
  if (typeof invite.expiresAt !== "number" || !Number.isFinite(invite.expiresAt)) {
    return { ok: false, error: "Invalid expiresAt" };
  }
  if (invite.expiresAt <= nowMs) {
    return { ok: false, error: "Pairing invite expired" };
  }
  if (invite.directUrls !== undefined) {
    if (!Array.isArray(invite.directUrls) || invite.directUrls.length > 8) {
      return { ok: false, error: "Invalid directUrls" };
    }
    for (const u of invite.directUrls) {
      if (!isAllowedWsUrl(u, true)) {
        return { ok: false, error: `Disallowed direct URL: ${u}` };
      }
    }
  }
  if (invite.relayUrl !== undefined && invite.relayUrl !== null && invite.relayUrl !== "") {
    if (!isAllowedWsUrl(invite.relayUrl, true)) {
      return { ok: false, error: "Disallowed relayUrl" };
    }
    if (!isNonEmptyString(invite.routeId, 128) || !ROUTE_ID_RE.test(invite.routeId)) {
      return { ok: false, error: "Invalid routeId" };
    }
  }
  return { ok: true };
}

/**
 * Validate WebSocket URL: rejects embedded credentials (user:pass@), enforces ws/wss scheme,
 * and allows plain ws:// ONLY for loopback / RFC1918 LAN / Tailscale CGNAT (100.64.0.0/10) when allowPrivatePlaintext=true.
 */
export function isAllowedWsUrl(rawUrl, allowPrivatePlaintext = false) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > 512) return false;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol === "wss:") return true;
  if (parsed.protocol === "ws:" && allowPrivatePlaintext) {
    return isPrivateOrLoopbackHost(parsed.hostname);
  }
  return false;
}

export function isPrivateOrLoopbackHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  if (h.endsWith(".local") || h.endsWith(".ts.net")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale CGNAT
  return false;
}

export function validateRpcRequest(msg) {
  if (!isPlainObject(msg)) return { ok: false, error: "Message must be an object" };
  if (msg.type !== "req") return { ok: false, error: "Expected type=req" };
  if (!isNonEmptyString(msg.id, 128) || !SAFE_ID_RE.test(msg.id)) {
    return { ok: false, error: "Invalid req id" };
  }
  if (!ALLOWED_RPC_METHODS.has(msg.method)) {
    return { ok: false, error: `Unknown RPC method: ${String(msg.method)}` };
  }
  if (msg.idempotencyKey !== undefined && (!isNonEmptyString(msg.idempotencyKey, 128) || !SAFE_ID_RE.test(msg.idempotencyKey))) {
    return { ok: false, error: "Invalid idempotencyKey" };
  }
  if (msg.params !== undefined && !isPlainObject(msg.params)) {
    return { ok: false, error: "RPC params must be a plain object" };
  }
  return { ok: true };
}

/**
 * Redact common secrets from outbound text/audit entries.
 */
export function redactSecrets(input) {
  if (typeof input !== "string") return "";
  return input
    .replace(/(sk-[A-Za-z0-9_-]{16,})/g, "[REDACTED_KEY]")
    .replace(/(gh[pousr]_[A-Za-z0-9]{20,})/g, "[REDACTED_GH_TOKEN]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED_TOKEN]")
    .replace(/([?&](?:token|key|secret|password|auth)=)[^&\s]+/gi, "$1[REDACTED]");
}
