import { createHash } from 'node:crypto';

const guid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const tokens = s => (s ?? '').split(',').map(x => x.trim());
const validClose = n => (n >= 1000 && n <= 1014 && ![1004, 1005, 1006].includes(n)) || (n >= 3000 && n <= 4999);

export function rejectUpgrade(socket, status = '400 Bad Request', headers = '') {
  socket.on('error', () => {});
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n${headers}Content-Length: 0\r\n\r\n`);
}

// The callback installs handlers before any pipelined upgrade head is consumed.
export function acceptWebSocket(req, socket, head, maxBytes, ready) {
  const h = req.headers;
  if (h['sec-websocket-version'] !== '13') return rejectUpgrade(socket, '426 Upgrade Required', 'Sec-WebSocket-Version: 13\r\n');
  const key = h['sec-websocket-key'];
  if (req.method !== 'GET' || req.httpVersion !== '1.1' || !h.host || h.upgrade?.toLowerCase() !== 'websocket' ||
      !tokens(h.connection?.toLowerCase()).includes('upgrade') || !/^[A-Za-z0-9+/]{22}==$/.test(key ?? '') ||
      Buffer.from(key, 'base64').toString('base64') !== key) return rejectUpgrade(socket);
  const protocol = 'pi-relay.v1';
  if (h['sec-websocket-protocol'] !== undefined) {
    const offered = tokens(h['sec-websocket-protocol']);
    if (!offered.includes(protocol) || new Set(offered).size !== offered.length ||
        offered.some(p => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(p))) return rejectUpgrade(socket);
  }
  const accept = createHash('sha1').update(key + guid).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${h['sec-websocket-protocol'] ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ''}\r\n`);
  socket.setTimeout(0);
  socket.setNoDelay(true);

  let closing = false, dead = false, writes = 0, closeTimer;
  const peer = {
    onText() {}, onClose() {}, onPong() {},
    text: text => writeFrame(1, Buffer.from(text)),
    ping: () => writeFrame(9, Buffer.alloc(0)),
    close(code = 1000, reason = '') {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code); payload.write(reason, 2);
      beginClose(payload);
    },
    destroy: () => socket.destroy(),
  };
  function writeFrame(op, payload) {
    if (closing || dead || !socket.writable) return false;
    const n = payload.length, prefix = n < 126 ? 2 : n <= 65535 ? 4 : 10;
    if (writes >= 128 || socket.writableLength + prefix + n > Math.max(65536, maxBytes * 4 + 40)) {
      socket.destroy(); dead = true; return false;
    }
    const frame = Buffer.allocUnsafe(prefix + n);
    frame[0] = 0x80 | op; frame[1] = prefix === 2 ? n : prefix === 4 ? 126 : 127;
    if (prefix === 4) frame.writeUInt16BE(n, 2);
    if (prefix === 10) frame.writeBigUInt64BE(BigInt(n), 2);
    payload.copy(frame, prefix);
    writes++; socket.write(frame, () => { writes--; });
    return true;
  }
  function beginClose(payload) {
    if (closing) return;
    writeFrame(8, payload); closing = true;
    closeTimer = setTimeout(() => socket.destroy(), 1000).unref();
  }
  function fail(code) {
    if (code === 1009) peer.text('{"t":"error","code":"FRAME_TOO_LARGE","message":"Frame too large"}');
    peer.close(code); socket.removeListener('data', consume); socket.end();
    return false;
  }

  // Incremental header + streaming unmask into a geometrically grown message
  // buffer. One-byte TCP chunks and empty continuations do not grow a chunk list.
  const hdr = Buffer.alloc(14);
  let have = 0, need = 2, op, fin, length, pos, mask, target, start;
  let message = Buffer.alloc(0), used = 0, fragmented = false;
  function prefix() {
    op = hdr[0] & 15; fin = !!(hdr[0] & 128);
    const len7 = hdr[1] & 127;
    if ((hdr[0] & 112) || !(hdr[1] & 128) || ![0, 1, 2, 8, 9, 10].includes(op) || (op >= 8 && (!fin || len7 >= 126))) return fail(1002);
    if (op < 8 && ((op === 0) !== fragmented)) return fail(1002);
    if (op === 2) return fail(1003);
    return true;
  }
  function header() {
    const len7 = hdr[1] & 127;
    mask = need - 4;
    if (len7 === 127) {
      const n = hdr.readBigUInt64BE(2);
      if (n < 65536n || (hdr[2] & 128)) return fail(1002);
      if (n > BigInt(maxBytes)) return fail(1009);
      length = Number(n);
    } else if (len7 === 126) {
      length = hdr.readUInt16BE(2); if (length < 126) return fail(1002);
    } else length = len7;
    if (op < 8) {
      if (used + length > maxBytes) return fail(1009);
      if (message.length < used + length) {
        const next = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(used + length, 2 * message.length)));
        message.copy(next, 0, 0, used); message = next;
      }
      start = used; target = message;
    } else { start = 0; target = Buffer.allocUnsafe(length); }
    pos = 0; return true;
  }
  function complete() {
    if (op < 8) {
      used += length; fragmented = !fin;
      if (fin) {
        let text;
        try { text = utf8.decode(message.subarray(0, used)); } catch { return fail(1007); }
        message = Buffer.alloc(0); used = 0;
        if (!closing) peer.onText(text);
      }
    } else if (op === 8) {
      if (length === 1 || (length >= 2 && !validClose(target.readUInt16BE()))) return fail(1002);
      try { utf8.decode(target.subarray(2)); } catch { return fail(1007); }
      beginClose(target); socket.removeListener('data', consume); socket.end(); return false;
    } else if (op === 9) writeFrame(10, target);
    else peer.onPong();
    target = undefined; return true;
  }
  function consume(chunk) {
    let i = 0;
    while (i < chunk.length && !dead) {
      if (have < need) {
        const count = Math.min(need - have, chunk.length - i);
        chunk.copy(hdr, have, i, i + count); have += count; i += count;
        if (have < need) return;
        if (need === 2) {
          if (!prefix()) return;
          const l = hdr[1] & 127; need = 6 + (l === 126 ? 2 : l === 127 ? 8 : 0); continue;
        }
        if (!header()) return;
      }
      const count = Math.min(length - pos, chunk.length - i);
      for (let j = 0; j < count; j++) target[start + pos + j] = chunk[i + j] ^ hdr[mask + ((pos + j) & 3)];
      i += count; pos += count;
      if (pos === length) {
        if (!complete()) return;
        have = 0; need = 2;
      }
    }
  }
  socket.on('error', () => socket.destroy());
  socket.on('end', () => socket.end());
  socket.once('close', () => { dead = true; clearTimeout(closeTimer); peer.onClose(); });
  ready(peer);
  socket.on('data', consume);
  if (head.length) consume(head);
}
