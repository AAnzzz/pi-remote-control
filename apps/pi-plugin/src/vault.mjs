/**
 * Encrypted local state vault & redacted rolling audit log inside plugin private data directory.
 * Uses AES-256-GCM with per-installation key file (0600); refuses silent plaintext downgrade on corruption.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactSecrets, randomId, bytesToBase64 } from "./vendor/protocol/index.mjs";

const VAULT_FILE = "vault.enc.json";
const KEY_FILE = ".vault-key";
const AUDIT_FILE = "audit.jsonl";
const MAX_AUDIT_BYTES = 1_048_576; // 1 MiB

function atomicWriteFile(filePath, content, mode = 0o600) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, { encoding: "utf8", mode });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Windows chmod is best-effort
  }
}

export class PluginVault {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.vaultPath = path.join(dataDir, VAULT_FILE);
    this.keyPath = path.join(dataDir, KEY_FILE);
    this.auditPath = path.join(dataDir, AUDIT_FILE);
    this._masterKey = this._loadOrCreateMasterKey();
    this.state = this._loadState();
  }

  _loadOrCreateMasterKey() {
    if (fs.existsSync(this.keyPath)) {
      const raw = fs.readFileSync(this.keyPath, "utf8").trim();
      const buf = Buffer.from(raw, "base64");
      if (buf.length !== 32) {
        throw new Error("Vault master key is corrupted (expected 32 bytes); refusing plaintext fallback");
      }
      return buf;
    }
    const key = crypto.randomBytes(32);
    atomicWriteFile(this.keyPath, key.toString("base64"), 0o600);
    return key;
  }

  _createDefaultState() {
    return {
      v: 1,
      hostId: `host_${randomId(12)}`,
      routeId: randomId(24),
      hostSecret: bytesToBase64(crypto.randomBytes(32)),
      allowedProjects: [], // empty = all projects in PI-Desktop scope; non-empty = explicit whitelist
      devices: {}, // deviceId -> { deviceId, name, keyId, sessionKeyB64, pairedAt, lastSeenAt, permissions }
    };
  }

  _loadState() {
    if (!fs.existsSync(this.vaultPath)) {
      const initial = this._createDefaultState();
      this.save(initial);
      return initial;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.vaultPath, "utf8"));
    } catch (err) {
      throw new Error(`Vault file JSON unreadable: ${err.message}`);
    }
    if (!parsed || parsed.v !== 1 || parsed.alg !== "AES-256-GCM") {
      throw new Error("Vault format invalid or unencrypted; refusing plaintext downgrade");
    }
    const iv = Buffer.from(parsed.iv, "base64");
    const ct = Buffer.from(parsed.ct, "base64");
    const tag = Buffer.from(parsed.tag, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this._masterKey, iv);
    decipher.setAuthTag(tag);
    decipher.setAAD(Buffer.from("pi-remote-vault-v1", "utf8"));
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    const data = JSON.parse(plain);
    if (!data || typeof data !== "object" || !data.hostId) {
      throw new Error("Vault decrypted payload malformed");
    }
    if (!data.devices || typeof data.devices !== "object") data.devices = {};
    if (!Array.isArray(data.allowedProjects)) data.allowedProjects = [];
    return data;
  }

  save(nextState = this.state) {
    this.state = nextState;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this._masterKey, iv);
    cipher.setAAD(Buffer.from("pi-remote-vault-v1", "utf8"));
    const plain = Buffer.from(JSON.stringify(nextState), "utf8");
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();

    const envelope = {
      v: 1,
      alg: "AES-256-GCM",
      iv: iv.toString("base64"),
      ct: ct.toString("base64"),
      tag: tag.toString("base64"),
      updatedAt: new Date().toISOString(),
    };
    atomicWriteFile(this.vaultPath, JSON.stringify(envelope, null, 2), 0o600);
  }

  getHostIdentity(customName = "") {
    return {
      hostId: this.state.hostId,
      hostName: customName && customName.trim() ? customName.trim() : os.hostname(),
      routeId: this.state.routeId,
      hostSecret: this.state.hostSecret,
    };
  }

  listDevicesPublic() {
    return Object.values(this.state.devices).map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      keyId: d.keyId,
      pairedAt: d.pairedAt,
      lastSeenAt: d.lastSeenAt,
      permissions: d.permissions || ["read", "prompt", "abort", "diff"],
    }));
  }

  addDevice(deviceRecord) {
    this.state.devices[deviceRecord.deviceId] = deviceRecord;
    this.save();
  }

  touchDevice(deviceId) {
    const dev = this.state.devices[deviceId];
    if (!dev) return;
    dev.lastSeenAt = new Date().toISOString();
    this.save();
  }

  removeDevice(deviceId) {
    if (!this.state.devices[deviceId]) return false;
    delete this.state.devices[deviceId];
    this.save();
    return true;
  }

  setAllowedProjects(projectPaths) {
    this.state.allowedProjects = Array.from(new Set(projectPaths.filter((p) => typeof p === "string" && p.length > 0)));
    this.save();
  }

  appendAudit(action, details = {}) {
    try {
      if (fs.existsSync(this.auditPath)) {
        const stat = fs.statSync(this.auditPath);
        if (stat.size > MAX_AUDIT_BYTES) {
          const prev = `${this.auditPath}.1`;
          if (fs.existsSync(prev)) fs.unlinkSync(prev);
          fs.renameSync(this.auditPath, prev);
        }
      }
      const safeDetails = JSON.parse(redactSecrets(JSON.stringify(details)));
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        action,
        ...safeDetails,
      });
      fs.appendFileSync(this.auditPath, line + "\n", { encoding: "utf8", mode: 0o600 });
    } catch {
      // audit write must never crash remote bridge
    }
  }

  readRecentAudit(limit = 50) {
    if (!fs.existsSync(this.auditPath)) return [];
    try {
      const lines = fs.readFileSync(this.auditPath, "utf8").trim().split("\n").filter(Boolean);
      return lines.slice(-limit).reverse().map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { ts: "", action: "raw", detail: l };
        }
      });
    } catch {
      return [];
    }
  }
}
