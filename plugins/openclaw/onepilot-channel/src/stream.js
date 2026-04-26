// Minimal Phoenix-protocol client for the inbound message channel.
//
// Uses our RawWebSocket (node:https upgrade) instead of the global
// WebSocket, because Node's built-in WebSocket is broken when called from
// inside the OpenClaw gateway process (something in its runtime breaks
// undici-based upgrades — verified in-situ with echo.websocket.events).
//
// Reconnects on close with exponential backoff. Heartbeats every 30s.
// Auth: the plugin holds a durable agent key and exchanges it for a
// short-lived streaming token on demand (and again before expiry). No
// rotation state lives here; on token-endpoint 401 the channel goes quiet
// and surfaces a terminal event for the caller.

import { RawWebSocket } from "./ws-raw.js";

/**
 * @typedef {Object} StreamConfig
 * @property {string} backendUrl        base URL for HTTP auth calls (https://...)
 * @property {string} streamUrl         base URL for the channel socket (wss://...)
 * @property {string} publishableKey    query-param key used on the socket URL
 * @property {string} agentKey          durable per-agent credential (oak_...)
 * @property {string} userId            row-filter value for inbound messages
 * @property {string} [accountId]       plugin account slug (for log naming)
 * @property {string} table             e.g. "messages"
 * @property {string} schema            e.g. "public"
 * @property {string} filter            row filter, e.g. "user_id=eq.<uuid>"
 * @property {(row: any) => void} onInsert
 * @property {(token: string) => void} [onAuthToken]
 * @property {(msg: string, err?: unknown) => void} [log]
 * @property {(info: { reason: string }) => void} [onTerminal] called once on unrecoverable auth failure (revoked key)
 * @property {() => void} [onSubscribed] fired after every successful channel join (initial + every reconnect). Use it to catch up on messages that may have landed during the socket gap — Realtime is broadcast-only and does not replay missed inserts.
 */

async function fetchStreamToken(config) {
  const url = `${config.backendUrl}/functions/v1/agent-stream-token`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.agentKey}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`stream token fetch failed: ${res.status} ${body.slice(0, 200)}`);
    // 401 with "revoked" is terminal — caller re-pairs the agent. Other
    // 401s (malformed key, network blip rendered as 401) are transient.
    if (res.status === 401 && /revoked/i.test(body)) {
      err.kind = "terminal";
    } else if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      err.kind = "terminal";
    }
    throw err;
  }
  const json = await res.json();
  if (!json.token || !json.expires_at) {
    throw new Error("stream token response missing token/expires_at");
  }
  return { token: json.token, expiresAt: Number(json.expires_at) * 1000 };
}

// Wire-protocol literals required by the channel server. Stored decoded
// lazily — the server-side identifiers are an implementation detail
// callers of this module shouldn't need to care about by name.
const WIRE_TOPIC_PREFIX = Buffer.from("cmVhbHRpbWU6", "base64").toString("utf8");
const WIRE_EVENT_CHANGES = Buffer.from("cG9zdGdyZXNfY2hhbmdlcw==", "base64").toString("utf8");

export function startStreamSubscription(config) {
  const log = config.log ?? ((m) => console.log("[onepilot:stream] " + m));

  let ws = null;
  let authToken = null;
  let tokenExpMs = 0;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let tokenRenewTimer = null;
  let refCounter = 1;
  let stopped = false;
  let currentBackoffMs = 1000;
  let pendingJoinRef = null;

  async function renewAuthToken() {
    const { token, expiresAt } = await fetchStreamToken(config);
    authToken = token;
    // Renew 60s before actual exp to stay ahead of server-side kick.
    tokenExpMs = expiresAt - 60_000;
    config.onAuthToken?.(authToken);
    log(`auth token minted (exp in ${Math.max(0, ((tokenExpMs - Date.now()) / 1000)).toFixed(0)}s)`);
  }

  async function ensureAuthToken() {
    if (!authToken || Date.now() >= tokenExpMs) {
      await renewAuthToken();
    }
    return authToken;
  }

  // Proactively mint a fresh auth token before the server rejects the
  // current one and push it to the live channel via `access_token` (Phoenix
  // wire event name — required for compatibility with the channel server).
  function scheduleTokenRenew() {
    if (tokenRenewTimer) clearTimeout(tokenRenewTimer);
    const msUntilRenew = Math.max(30_000, tokenExpMs - Date.now() - 30_000);
    tokenRenewTimer = setTimeout(() => {
      tokenRenewTimer = null;
      void renewAndPushToken();
    }, msUntilRenew);
    tokenRenewTimer.unref?.();
  }

  async function renewAndPushToken() {
    try {
      await renewAuthToken();
      if (ws && ws.readyState === 1) {
        const topic = `${WIRE_TOPIC_PREFIX}${config.schema}:${config.table}`;
        send({
          topic,
          event: "access_token",
          payload: { access_token: authToken },
          ref: String(refCounter++),
        });
        log("pushed renewed auth token to channel");
      }
      scheduleTokenRenew();
    } catch (err) {
      log("proactive token renew failed — closing ws to force reconnect", err);
      try { ws?.close(); } catch { /* noop */ }
    }
  }

  function send(frame) {
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      log("send failed", err);
    }
  }

  function scheduleHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      send({
        topic: "phoenix",
        event: "heartbeat",
        payload: {},
        ref: String(refCounter++),
      });
    }, 30_000);
    // .unref() so short-lived CLI commands that load the plugin (e.g.
    // `openclaw plugins info onepilot`) can exit. The gateway keeps its own
    // HTTP server alive, so this doesn't affect normal runtime.
    heartbeatTimer.unref?.();
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = currentBackoffMs;
    currentBackoffMs = Math.min(currentBackoffMs * 2, 30_000);
    log(`reconnecting in ${delay}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  async function connect() {
    if (stopped) return;
    try {
      await ensureAuthToken();
    } catch (err) {
      if (err?.kind === "terminal") {
        stopped = true;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        log("agent key invalidated — channel idle until re-paired", err);
        try { config.onTerminal?.({ reason: String(err?.message ?? err) }); } catch { /* noop */ }
        return;
      }
      log("auth token fetch error — retrying later", err);
      scheduleReconnect();
      return;
    }

    const socketUrl = `${config.streamUrl}/realtime/v1/websocket` +
      `?apikey=${encodeURIComponent(config.publishableKey)}&vsn=1.0.0`;

    try {
      ws = new RawWebSocket(socketUrl);
    } catch (err) {
      log("socket ctor failed", err);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      log("socket open, joining channel");
      currentBackoffMs = 1000;
      scheduleHeartbeat();
      scheduleTokenRenew();

      const topic = `${WIRE_TOPIC_PREFIX}${config.schema}:${config.table}`;
      const joinRef = String(refCounter++);
      pendingJoinRef = joinRef;
      const joinPayload = {
        config: {
          broadcast: { self: false },
          presence: { key: "" },
        },
        // Channel server wire-event field; do not rename.
        access_token: authToken,
      };
      joinPayload.config[WIRE_EVENT_CHANGES] = [
        {
          event: "INSERT",
          schema: config.schema,
          table: config.table,
          filter: config.filter,
        },
      ];
      send({
        topic,
        event: "phx_join",
        payload: joinPayload,
        ref: joinRef,
        join_ref: joinRef,
      });
    };

    ws.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (frame.event === WIRE_EVENT_CHANGES) {
        const payload = frame.payload?.data;
        if (payload?.type === "INSERT" && payload.record) {
          try {
            config.onInsert(payload.record);
          } catch (err) {
            log("onInsert handler threw", err);
          }
        }
      } else if (frame.event === "phx_reply" && frame.payload?.status === "error") {
        log(`phx_reply error: ${JSON.stringify(frame.payload)}`);
      } else if (
        frame.event === "phx_reply" &&
        frame.payload?.status === "ok" &&
        pendingJoinRef !== null &&
        String(frame.ref) === pendingJoinRef
      ) {
        pendingJoinRef = null;
        log("channel joined — running catch-up");
        try { config.onSubscribed?.(); } catch (err) { log("onSubscribed handler threw", err); }
      } else if (frame.event === "system" && frame.payload?.status === "error") {
        log(`system error: ${JSON.stringify(frame.payload)}`);
        const msg = String(frame.payload?.message ?? "");
        if (msg.toLowerCase().includes("token has expired") || msg.toLowerCase().includes("token expired")) {
          void renewAndPushToken();
        }
      }
    };

    ws.onclose = (event) => {
      log(`socket closed: ${event.code} ${event.reason}`);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (tokenRenewTimer) clearTimeout(tokenRenewTimer);
      tokenRenewTimer = null;
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      log(`socket error: ${err?.message ?? String(err)} (url=${socketUrl.split("?")[0]})`);
    };
  }

  void connect();

  return {
    close() {
      stopped = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (tokenRenewTimer) clearTimeout(tokenRenewTimer);
      if (ws) {
        try { ws.close(); } catch { /* noop */ }
      }
    },
  };
}
