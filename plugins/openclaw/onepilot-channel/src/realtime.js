// Minimal Supabase Realtime v2 (Phoenix protocol) client.
//
// Uses our RawWebSocket (node:https upgrade) instead of the global
// WebSocket, because Node's built-in WebSocket is broken when called from
// inside the OpenClaw gateway process (something in its runtime breaks
// undici-based upgrades — verified in-situ with echo.websocket.events).
//
// Reconnects on close with exponential backoff. Heartbeats every 30s.
// Auto-refreshes the user's access token via the refresh_token grant.

import { RawWebSocket } from "./ws-raw.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {Object} RealtimeConfig
 * @property {string} supabaseUrl
 * @property {string} supabaseAnonKey
 * @property {string} userRefreshToken
 * @property {string} userId
 * @property {string} table            e.g. "messages"
 * @property {string} schema           e.g. "public"
 * @property {string} filter           PostgREST filter, e.g. "user_id=eq.<uuid>"
 * @property {string} [accountId]      plugin account slug (for token cache naming)
 * @property {(row: any) => void} onInsert
 * @property {(accessToken: string) => void} [onAccessToken]
 * @property {(msg: string, err?: unknown) => void} [log]
 */

// Supabase rotates the refresh_token on every use. We persist the rotated
// value to disk so plugin restarts (VPS reboot, gateway crash) don't fall
// back to the stale token baked in at deploy-time. Without this, a user's
// plugin can wedge indefinitely after ~24h offline and require a re-deploy.
async function persistRefreshToken(accountId, token) {
  const dir = path.join(__dirname, "..", "tokens");
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tokenFile = path.join(dir, `${accountId || "default"}.json`);
    const tmp = `${tokenFile}.tmp`;
    const payload = JSON.stringify({ refresh_token: token, updated_at: Date.now() });
    await fs.writeFile(tmp, payload, { mode: 0o600 });
    await fs.rename(tmp, tokenFile);
  } catch (err) {
    // Non-fatal: token remains in memory. Next restart falls back to the
    // config value, which may or may not still be valid.
    throw err;
  }
}

export async function loadCachedRefreshToken(accountId, fallback) {
  try {
    const tokenFile = path.join(__dirname, "..", "tokens", `${accountId || "default"}.json`);
    const data = await fs.readFile(tokenFile, "utf8");
    const parsed = JSON.parse(data);
    return typeof parsed.refresh_token === "string" && parsed.refresh_token
      ? parsed.refresh_token
      : fallback;
  } catch {
    return fallback;
  }
}

export function startRealtimeSubscription(config) {
  const log = config.log ?? ((m) => console.log("[onepilot:realtime] " + m));

  let ws = null;
  let accessToken = null;
  let tokenExpMs = 0;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let tokenRefreshTimer = null;
  let refCounter = 1;
  let stopped = false;
  let currentBackoffMs = 1000;

  // `staticAccessToken`: a long-lived JWT minted by the iOS client via the
  // `mint-plugin-jwt` edge function. When present, we skip the entire
  // refresh_token flow — the token is used directly until it expires (90
  // days by default), at which point iOS re-mints + re-writes the config on
  // next deploy or chat-open. This sidesteps the "refresh_token_already_used"
  // wedge that occurred when multiple plugins shared one user session.
  const hasStaticToken = typeof config.staticAccessToken === "string" && config.staticAccessToken.length > 0;
  if (hasStaticToken) {
    accessToken = config.staticAccessToken;
    // Parse exp out of the JWT so the connection does a timely close-reconnect
    // before the server kicks us. Don't crash if parsing fails — fall back to
    // a long timeout so we still close eventually.
    try {
      const claims = JSON.parse(Buffer.from(config.staticAccessToken.split(".")[1], "base64url").toString("utf8"));
      if (claims?.exp) tokenExpMs = claims.exp * 1000;
    } catch { /* noop */ }
    if (!tokenExpMs) tokenExpMs = Date.now() + 60 * 60 * 1000;
    config.onAccessToken?.(accessToken);
  }

  async function refreshJwt() {
    if (hasStaticToken) {
      // Static token mode: nothing to refresh. If we're here it means the
      // token has expired — abort and let the plugin stay quiet until iOS
      // re-mints + re-deploys.
      throw new Error("static plugin jwt expired; re-deploy agent from iOS to mint a fresh one");
    }
    const url = `${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "apikey": config.supabaseAnonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: config.userRefreshToken }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`refresh_token grant failed: ${res.status} ${body}`);
    }
    const json = await res.json();
    if (!json.access_token) throw new Error("refresh_token grant returned no access_token");
    accessToken = json.access_token;
    tokenExpMs = Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000; // refresh 1 min early
    config.onAccessToken?.(accessToken);
    if (json.refresh_token) {
      // Supabase rotates refresh_tokens — the old one is invalidated by this
      // call. Persist the new one to disk so plugin restarts after hours or
      // days of downtime still have a valid token to start from.
      config.userRefreshToken = json.refresh_token;
      try {
        await persistRefreshToken(config.accountId, json.refresh_token);
      } catch (err) {
        log("refresh_token persist failed (token kept in memory)", err);
      }
    }
    log(`jwt refreshed (exp in ${((tokenExpMs - Date.now()) / 1000).toFixed(0)}s)`);
  }

  async function ensureJwt() {
    if (!accessToken || Date.now() >= tokenExpMs) {
      await refreshJwt();
    }
    return accessToken;
  }

  // Proactively refresh the JWT before the server expires it and push the new
  // token to the live channel via `access_token`. Without this, the socket
  // stays open past expiry and Realtime starts rejecting our events with
  // `system error: Token has expired 0 seconds ago` — messages inserted into
  // Supabase after that silently never reach us.
  function scheduleTokenRefresh() {
    if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);
    const msUntilRefresh = Math.max(30_000, tokenExpMs - Date.now() - 30_000);
    tokenRefreshTimer = setTimeout(() => {
      tokenRefreshTimer = null;
      void refreshAndPushToken();
    }, msUntilRefresh);
    tokenRefreshTimer.unref?.();
  }

  async function refreshAndPushToken() {
    try {
      await refreshJwt();
      if (ws && ws.readyState === 1) {
        const topic = `realtime:${config.schema}:${config.table}`;
        send({
          topic,
          event: "access_token",
          payload: { access_token: accessToken },
          ref: String(refCounter++),
        });
        log("sent access_token update to channel");
      }
      scheduleTokenRefresh();
    } catch (err) {
      log("proactive token refresh failed — closing ws to force reconnect", err);
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
      await ensureJwt();
    } catch (err) {
      log("jwt refresh error — retrying later", err);
      scheduleReconnect();
      return;
    }

    const realtimeUrl = config.supabaseUrl.replace(/^http/, "ws") +
      `/realtime/v1/websocket?apikey=${encodeURIComponent(config.supabaseAnonKey)}&vsn=1.0.0`;

    try {
      ws = new RawWebSocket(realtimeUrl);
    } catch (err) {
      log("RawWebSocket ctor failed", err);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      log("ws open, joining channel");
      currentBackoffMs = 1000; // reset backoff
      scheduleHeartbeat();
      // With a static long-lived JWT there's nothing to refresh — the plugin
      // just stays connected until expiry, at which point the server boots
      // the socket and iOS re-mints on next deploy.
      if (!hasStaticToken) scheduleTokenRefresh();

      const topic = `realtime:${config.schema}:${config.table}`;
      const joinRef = String(refCounter++);
      send({
        topic,
        event: "phx_join",
        payload: {
          config: {
            postgres_changes: [
              {
                event: "INSERT",
                schema: config.schema,
                table: config.table,
                filter: config.filter,
              },
            ],
            broadcast: { self: false },
            presence: { key: "" },
          },
          access_token: accessToken,
        },
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
      if (frame.event === "postgres_changes") {
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
      } else if (frame.event === "system" && frame.payload?.status === "error") {
        log(`system error: ${JSON.stringify(frame.payload)}`);
        // Server says our token expired — refresh immediately and push new
        // token. If that fails, refreshAndPushToken closes the ws, which
        // triggers scheduleReconnect → full reconnect path with fresh jwt.
        const msg = String(frame.payload?.message ?? "");
        if (msg.toLowerCase().includes("token has expired") || msg.toLowerCase().includes("token expired")) {
          void refreshAndPushToken();
        }
      }
    };

    ws.onclose = (event) => {
      log(`ws closed: ${event.code} ${event.reason}`);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);
      tokenRefreshTimer = null;
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      log(`ws error: ${err?.message ?? String(err)} (url=${realtimeUrl.split("?")[0]})`);
      // 'close' fires next — reconnect there
    };
  }

  // Before first connect, upgrade the in-memory refresh_token to the
  // disk-cached one if available. Handles VPS reboot after days offline
  // where the config-baked token is stale but the cache has the latest.
  (async () => {
    try {
      const cached = await loadCachedRefreshToken(config.accountId, null);
      if (cached && cached !== config.userRefreshToken) {
        config.userRefreshToken = cached;
        log("using persisted refresh_token from token cache");
      }
    } catch { /* noop */ }
    void connect();
  })();

  return {
    close() {
      stopped = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);
      if (ws) {
        try { ws.close(); } catch { /* noop */ }
      }
    },
  };
}
