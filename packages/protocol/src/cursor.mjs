/**
 * Bounded replay cursor log, streaming delta coalescer, and idempotency registry for pi-remote.v1.
 */

import { sha256Hex } from "./crypto.mjs";

/**
 * Bounded per-host event log with epoch + monotonically increasing sequence numbers.
 * Enables gap-free mobile resume after backgrounding/sleep and deterministic snapshot fallback.
 */
export class EventCursorLog {
  constructor({ epoch, maxEvents = 5000 } = {}) {
    this.epoch = epoch || `ep-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.maxEvents = maxEvents;
    this.seq = 0;
    this.buffer = [];
  }

  append(event, payload, sessionId = null) {
    this.seq += 1;
    const entry = {
      type: "evt",
      epoch: this.epoch,
      seq: this.seq,
      transient: false,
      sessionId,
      event,
      payload,
      ts: Date.now(),
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.maxEvents) {
      this.buffer.splice(0, this.buffer.length - this.maxEvents);
    }
    return entry;
  }

  /**
   * Pull events after client's last acknowledged (epoch, afterSeq).
   * If epoch mismatches or requested cursor has been evicted, returns { needsSnapshot: true }.
   */
  pull({ epoch, afterSeq = 0, limit = 200, sessionId = null } = {}) {
    if (!epoch || epoch !== this.epoch) {
      return {
        epoch: this.epoch,
        currentSeq: this.seq,
        needsSnapshot: true,
        events: [],
      };
    }
    const oldestAvailable = this.buffer.length > 0 ? this.buffer[0].seq : this.seq + 1;
    if (afterSeq > this.seq || (afterSeq < oldestAvailable - 1 && this.buffer.length > 0)) {
      return {
        epoch: this.epoch,
        currentSeq: this.seq,
        needsSnapshot: true,
        events: [],
      };
    }
    const filtered = [];
    for (const evt of this.buffer) {
      if (evt.seq <= afterSeq) continue;
      if (sessionId && evt.sessionId && evt.sessionId !== sessionId) continue;
      filtered.push(evt);
      if (filtered.length >= limit) break;
    }
    return {
      epoch: this.epoch,
      currentSeq: this.seq,
      needsSnapshot: false,
      hasMore: filtered.length === limit && filtered[filtered.length - 1].seq < this.seq,
      events: filtered,
    };
  }
}

/**
 * Coalesces high-frequency streaming text/thinking deltas (default 100ms or 8 KiB) to protect
 * mobile battery & JS bridge performance, while allowing immediate flush on finalization/approvals.
 */
export class StreamDeltaCoalescer {
  constructor({ flushIntervalMs = 100, maxChunkBytes = 8192, onFlush }) {
    this.flushIntervalMs = flushIntervalMs;
    this.maxChunkBytes = maxChunkBytes;
    this.onFlush = onFlush;
    this.pending = new Map(); // key: `${sessionId}:${turnId}:${channel}` -> { sessionId, turnId, channel, delta, bytes }
    this.timer = null;
  }

  push({ sessionId, turnId, channel = "text", delta }) {
    if (!delta) return;
    const key = `${sessionId}:${turnId || "active"}:${channel}`;
    const prev = this.pending.get(key) || {
      sessionId,
      turnId: turnId || null,
      channel,
      delta: "",
      bytes: 0,
    };
    prev.delta += delta;
    prev.bytes += delta.length;
    this.pending.set(key, prev);

    if (prev.bytes >= this.maxChunkBytes) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushIntervalMs);
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return;
    const batch = Array.from(this.pending.values());
    this.pending.clear();
    for (const item of batch) {
      this.onFlush({
        sessionId: item.sessionId,
        turnId: item.turnId,
        channel: item.channel,
        delta: item.delta,
      });
    }
  }

  dispose() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }
}

/**
 * Idempotency registry scoped by (deviceId, idempotencyKey).
 * Same key + same canonical payload digest -> returns stored result.
 * Same key + different digest -> rejects with IDEMPOTENCY_CONFLICT.
 */
export class IdempotencyStore {
  constructor({ maxEntries = 1000, ttlMs = 30 * 60 * 1000 } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  _prune(now = Date.now()) {
    for (const [k, v] of this.entries) {
      if (now - v.createdAt > this.ttlMs) {
        this.entries.delete(k);
      }
    }
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }
  }

  async checkOrRun({ deviceId, idempotencyKey, method, params, execute }) {
    if (!idempotencyKey) {
      return { replayed: false, result: await execute() };
    }
    const now = Date.now();
    this._prune(now);
    const mapKey = `${deviceId}::${idempotencyKey}`;
    const digest = await sha256Hex(JSON.stringify({ method, params: params || {} }));
    const existing = this.entries.get(mapKey);

    if (existing) {
      if (existing.digest !== digest) {
        const err = new Error("Idempotency key reused with different payload");
        err.code = "IDEMPOTENCY_CONFLICT";
        throw err;
      }
      if (existing.pendingPromise) {
        return { replayed: true, result: await existing.pendingPromise };
      }
      return { replayed: true, result: existing.result };
    }

    const record = { digest, createdAt: now, pendingPromise: null, result: null };
    const promise = Promise.resolve().then(() => execute());
    record.pendingPromise = promise;
    this.entries.set(mapKey, record);

    try {
      const result = await promise;
      record.result = result;
      record.pendingPromise = null;
      return { replayed: false, result };
    } catch (err) {
      // Failed commands are removed so caller can investigate & explicitly retry
      this.entries.delete(mapKey);
      throw err;
    }
  }
}
