// Onepilot plugin for OpenClaw.
//
// Bridges iOS app user messages (stored in Supabase) to OpenClaw's agent
// runtime, and writes agent replies back to Supabase so the iOS client can
// receive them via Realtime + APNs push.
//
// Architecture:
//   1. iOS writes user row to Supabase.
//   2. This plugin (running inside the gateway process) receives the INSERT
//      via Supabase Realtime.
//   3. Plugin calls http://127.0.0.1:<gatewayPort>/v1/chat/completions locally.
//      The caller is the gateway itself, so there's no external client that can
//      disconnect — the LLM call always runs to completion, regardless of
//      iOS's lifecycle (this is why force-quit works).
//   4. Plugin POSTs the reply to the openclaw-message-ingest edge function.
//   5. Supabase DB trigger fires push-notify → APNs.

import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { startRealtimeSubscription } from "./realtime.js";
import { handleUserMessage } from "./messaging.js";

// Module-level dedupe. OpenClaw calls `register` multiple times per gateway
// lifetime (once per registration mode, plus re-registrations after config
// changes). If we create a new Realtime subscription per call, we get
// duplicate onInsert fires and a race against the gateway's chat-completions
// handler that corrupts `workspace-state.json`. Keep one subscription per
// accountId, ever, per process.
const _activeSubscriptions = new Map();

export default definePluginEntry({
  id: "onepilot",
  name: "Onepilot",
  description: "Bridges Onepilot iOS messages to OpenClaw agents via Supabase Realtime.",
  // register MUST be synchronous; our async work is fire-and-forget.
  register(api) {
    const pluginConfig = api.pluginConfig ?? {};
    const accounts = pluginConfig.accounts ?? {};
    const accountIds = Object.keys(accounts);

    const log = (msg) => api.logger.info?.(`[onepilot] ${msg}`);
    const warn = (msg, err) => {
      if (err) api.logger.warn?.(`[onepilot] ${msg}: ${String(err)}`);
      else api.logger.warn?.(`[onepilot] ${msg}`);
    };

    log(
      `plugin registered — ${accountIds.length} account(s) configured: ${
        accountIds.join(", ") || "(none)"
      }`,
    );

    // Gateway port + token are read from the resolved top-level config. They
    // live inside `api.config.gateway` — shape matches what `openclaw config
    // get gateway` shows.
    const gatewayPort = Number(api.config?.gateway?.port) || 18789;
    const gatewayToken =
      api.config?.gateway?.auth?.token ||
      api.config?.gateway?.http?.auth?.token ||
      "";

    if (!gatewayToken) {
      warn(
        "gateway auth token not found in config — self-fetches to /v1/chat/completions will 401",
      );
    }

    const subscriptions = [];

    for (const [accountId, account] of Object.entries(accounts)) {
      if (account?.enabled === false) {
        log(`[${accountId}] disabled, skipping`);
        continue;
      }
      if (_activeSubscriptions.has(accountId)) {
        log(`[${accountId}] subscription already active in this process, skipping (duplicate register call)`);
        continue;
      }
      const missing = [];
      for (const field of ["supabaseUrl", "supabaseAnonKey", "userId", "agentProfileId", "sessionKey", "userRefreshToken"]) {
        if (!account?.[field]) missing.push(field);
      }
      if (missing.length > 0) {
        warn(`[${accountId}] missing required config fields: ${missing.join(", ")}`);
        continue;
      }

      log(
        `[${accountId}] starting Realtime subscription ` +
          `user=${String(account.userId).slice(0, 8)} ` +
          `agent=${String(account.agentProfileId).slice(0, 8)}`,
      );

      // Shared state for access token — shared between Realtime (for auth) and messaging (for REST).
      let cachedAccessToken = null;
      const getAccessToken = () => {
        if (cachedAccessToken) return Promise.resolve(cachedAccessToken);
        // Realtime layer refreshes on its own cadence; if we got here before
        // the first refresh, trigger one manually.
        return refreshAccessToken(account).then((t) => {
          cachedAccessToken = t;
          return t;
        });
      };

      // Postgres UUIDs are stored lowercase. iOS sends uppercase (Swift's
      // default uuidString format), which causes Realtime's string-compare
      // filter to match zero rows. Normalize here once.
      const userIdLc = String(account.userId).toLowerCase();
      const agentProfileIdLc = String(account.agentProfileId).toLowerCase();

      const sub = startRealtimeSubscription({
        accountId,
        supabaseUrl: account.supabaseUrl,
        supabaseAnonKey: account.supabaseAnonKey,
        userRefreshToken: account.userRefreshToken,
        userId: userIdLc,
        schema: "public",
        table: "messages",
        filter: `user_id=eq.${userIdLc}`,
        onAccessToken: (t) => {
          cachedAccessToken = t;
        },
        onInsert: (row) => {
          if (row?.role !== "user") return;
          if (
            agentProfileIdLc &&
            row.agent_profile_id &&
            String(row.agent_profile_id).toLowerCase() !== agentProfileIdLc
          ) {
            return;
          }
          log(
            `[${accountId}] user message id=${String(row.id ?? "").slice(0, 8)} ` +
              `session=${row.session_key ?? "?"} — dispatching to agent`,
          );
          void handleUserMessage({
            api,
            accountId,
            account,
            userMessageRow: row,
            gatewayPort,
            gatewayToken,
            getAccessToken,
            log: (m, err) => {
              if (err) api.logger.warn?.(`[onepilot:${accountId}:dispatch] ${m}: ${String(err)}`);
              else api.logger.info?.(`[onepilot:${accountId}:dispatch] ${m}`);
            },
          });
        },
        log: (m, err) => {
          if (err) api.logger.warn?.(`[onepilot:${accountId}:rt] ${m}: ${String(err)}`);
          else api.logger.info?.(`[onepilot:${accountId}:rt] ${m}`);
        },
      });

      _activeSubscriptions.set(accountId, sub);
      subscriptions.push({ accountId, sub });
    }

    log(`${subscriptions.length} subscription(s) active`);
  },
});

async function refreshAccessToken(account) {
  const url = `${account.supabaseUrl}/auth/v1/token?grant_type=refresh_token`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "apikey": account.supabaseAnonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ refresh_token: account.userRefreshToken }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`refresh failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error("no access_token in refresh response");
  return json.access_token;
}
