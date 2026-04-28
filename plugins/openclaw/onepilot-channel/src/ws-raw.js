// Minimal WebSocket client built on Node's raw `https` module.
// Supports only what the inbound channel needs: text frames, close, ping/pong.

import https from "node:https";
import { createHash, randomBytes } from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class RawWebSocket {
  constructor(url, options = {}) {
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
    this._socket = null;
    this._connect();
  }

  _connect() {
    const u = new URL(this.url);
    const port = u.port ? Number(u.port) : (u.protocol === "wss:" ? 443 : 80);
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1").update(key + WS_GUID).digest("base64");

    const req = https.request({
      host: u.hostname,
      port,
      path: u.pathname + u.search,
      method: "GET",
      headers: {
        "Host": u.host,
        "Connection": "Upgrade",
        "Upgrade": "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
        ...(this.options.headers || {}),
      },
    });

    req.on("error", (err) => this._emitError(err));

    req.on("response", (res) => {
      const bodyChunks = [];
      res.on("data", (c) => bodyChunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(bodyChunks).toString("utf8").slice(0, 300);
        this._emitError(new Error(`upgrade refused: HTTP ${res.statusCode} ${body}`));
      });
    });

    req.on("upgrade", (upgradeRes, socket) => {
      const gotAccept = upgradeRes.headers["sec-websocket-accept"];
      if (gotAccept !== expectedAccept) {
        this._emitError(new Error(`bad sec-websocket-accept: ${gotAccept}`));
        try { socket.destroy(); } catch {}
        return;
      }
      this._socket = socket;
      socket.setNoDelay(true);
      // unref so short-lived CLI probes can exit; gateway has its own keepalive.
      socket.unref?.();
      this.readyState = 1;
      this.onopen?.();

      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (true) {
          const frame = _parseFrame(buf);
          if (!frame) break;
          buf = buf.subarray(frame.consumed);
          if (frame.opcode === 0x1) {
            this.onmessage?.({ data: frame.payload.toString("utf8") });
          } else if (frame.opcode === 0x8) {
            this.readyState = 3;
            this.onclose?.({ code: frame.code ?? 1005, reason: frame.reason ?? "" });
            try { socket.end(); } catch {}
            return;
          } else if (frame.opcode === 0x9) {
            this._sendFrame(0xA, frame.payload);
          }
        }
      });

      socket.on("error", (err) => this._emitError(err));
      socket.on("close", () => {
        if (this.readyState !== 3) {
          this.readyState = 3;
          this.onclose?.({ code: 1006, reason: "socket closed" });
        }
      });
    });

    req.end();
  }

  _emitError(err) {
    this.readyState = 3;
    this.onerror?.(err);
    this.onclose?.({ code: 1006, reason: err?.message || "error" });
  }

  send(text) {
    if (this.readyState !== 1 || !this._socket) return;
    this._sendFrame(0x1, Buffer.from(String(text), "utf8"));
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2 || !this._socket) return;
    this.readyState = 2;
    const reasonBuf = Buffer.from(reason, "utf8");
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this._sendFrame(0x8, payload);
    try { this._socket.end(); } catch {}
  }

  _sendFrame(opcode, payload) {
    const mask = randomBytes(4);
    const plen = payload.length;
    let header;
    if (plen < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | plen;
    } else if (plen < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(plen, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(plen), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.alloc(plen);
    for (let i = 0; i < plen; i++) masked[i] = payload[i] ^ mask[i & 3];
    try {
      this._socket.write(Buffer.concat([header, mask, masked]));
    } catch (err) {
      this._emitError(err);
    }
  }
}

function _parseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const opcode = b0 & 0x0F;
  const fin = (b0 & 0x80) !== 0;
  const masked = (b1 & 0x80) !== 0;
  let plen = b1 & 0x7F;
  let offset = 2;
  if (plen === 126) {
    if (buf.length < offset + 2) return null;
    plen = buf.readUInt16BE(offset);
    offset += 2;
  } else if (plen === 127) {
    if (buf.length < offset + 8) return null;
    plen = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + plen) return null;
  let payload = buf.subarray(offset, offset + plen);
  if (masked && maskKey) {
    const unmasked = Buffer.alloc(plen);
    for (let i = 0; i < plen; i++) unmasked[i] = payload[i] ^ maskKey[i & 3];
    payload = unmasked;
  }
  const consumed = offset + plen;
  let code, reason;
  if (opcode === 0x8 && plen >= 2) {
    code = payload.readUInt16BE(0);
    reason = payload.subarray(2).toString("utf8");
  }
  return { opcode, fin, payload, consumed, code, reason };
}
