/**
 * Minimal RFC 6455 WebSocket server over Node's built-in node:http & node:crypto.
 * Zero external dependencies, zero eval/new Function, bounded frame length.
 */

import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class MinimalWsClient extends EventEmitter {
  constructor(socket, _req, maxFrameBytes = 262_144) {
    super();
    this.socket = socket;
    this.maxFrameBytes = maxFrameBytes;
    this.readyState = 1; // OPEN
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = null;
    this._fragmentTotal = 0;

    socket.setNoDelay(true);
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._handleClosed(1006, ""));
    socket.on("error", (err) => {
      this.emit("error", err);
      this._handleClosed(1006, err.message || "");
    });
  }

  _handleClosed(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, reason);
  }

  sendText(text) {
    if (this.readyState !== 1) return false;
    const payload = Buffer.from(String(text), "utf8");
    return this._writeFrame(0x1, payload);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 2;
    const reasonBuf = Buffer.from(String(reason).slice(0, 120), "utf8");
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    try {
      this._writeFrame(0x8, payload);
      this.socket.end();
    } catch {
      // ignore socket teardown error
    }
    this._handleClosed(code, reason);
  }

  _writeFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
      return true;
    } catch {
      return false;
    }
  }

  _onData(chunk) {
    if (this.readyState !== 1) return;
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);
    if (this._buffer.length > this.maxFrameBytes + 64) {
      this.close(1009, "Frame too large");
      return;
    }

    while (this._buffer.length >= 2) {
      const b0 = this._buffer[0];
      const b1 = this._buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (!masked) {
        this.close(1002, "Client frames must be masked");
        return;
      }

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return;
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return;
        const bigLen = this._buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(this.maxFrameBytes)) {
          this.close(1009, "Frame too large");
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > this.maxFrameBytes) {
        this.close(1009, "Frame too large");
        return;
      }

      const frameTotal = offset + 4 + payloadLen;
      if (this._buffer.length < frameTotal) return;

      const maskKey = this._buffer.subarray(offset, offset + 4);
      const maskedPayload = this._buffer.subarray(offset + 4, frameTotal);
      this._buffer = this._buffer.subarray(frameTotal);

      const unmasked = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = maskedPayload[i] ^ maskKey[i & 3];
      }

      if (opcode === 0x8) {
        const code = unmasked.length >= 2 ? unmasked.readUInt16BE(0) : 1000;
        const reason = unmasked.length > 2 ? unmasked.subarray(2).toString("utf8") : "";
        this.close(code, reason);
        return;
      }
      if (opcode === 0x9) {
        this._writeFrame(0xA, unmasked);
        continue;
      }
      if (opcode === 0xA) {
        this.emit("pong", unmasked);
        continue;
      }

      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          if (opcode === 0x1) {
            this.emit("message", unmasked.toString("utf8"));
          }
        } else {
          this._fragmentOpcode = opcode;
          this._fragments = [unmasked];
          this._fragmentTotal = unmasked.length;
        }
      } else if (opcode === 0x0 && this._fragmentOpcode !== null) {
        this._fragmentTotal += unmasked.length;
        if (this._fragmentTotal > this.maxFrameBytes) {
          this.close(1009, "Fragmented message too large");
          return;
        }
        this._fragments.push(unmasked);
        if (fin) {
          const full = Buffer.concat(this._fragments, this._fragmentTotal);
          const op = this._fragmentOpcode;
          this._fragments = [];
          this._fragmentOpcode = null;
          this._fragmentTotal = 0;
          if (op === 0x1) {
            this.emit("message", full.toString("utf8"));
          }
        }
      } else {
        this.close(1002, "Protocol error");
        return;
      }
    }
  }
}

export function attachMinimalWsServer(httpServer, { path: expectedPath = "/ws", maxFrameBytes = 262_144, onConnection }) {
  httpServer.on("upgrade", (req, socket) => {
    try {
      const parsed = new URL(req.url || "/", "http://localhost");
      if (parsed.pathname !== expectedPath) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const key = req.headers["sec-websocket-key"];
      const upgrade = String(req.headers.upgrade || "").toLowerCase();
      if (!key || upgrade !== "websocket") {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "",
          "",
        ].join("\r\n")
      );
      const client = new MinimalWsClient(socket, req, maxFrameBytes);
      onConnection(client, req);
    } catch {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
  });
}
