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
import { sendOnepilotText } from "./outbound.js";

// Module-level dedupe. OpenClaw calls `register` multiple times per gateway
// lifetime (once per registration mode, plus re-registrations after config
// changes). If we create a new Realtime subscription per call, we get
// duplicate onInsert fires and a race against the gateway's chat-completions
// handler that corrupts `workspace-state.json`. Keep one subscription per
// accountId, ever, per process.
const _activeSubscriptions = new Map();

// Same shape: register the outbound `onepilot` channel exactly once per
// gateway process, regardless of how many times `register` is invoked.
let _channelRegistered = false;

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

    // Register `onepilot` as a real outbound channel so OpenClaw's cron
    // (and any other outbound delivery path) can dispatch to it. Without
    // this, cron jobs fail at fire-time with "channel is required" because
    // the channel resolver can't find an `onepilot` entry in the registry.
    // Inbound stays on the Realtime subscription below — the channel is
    // outbound-only.
    if (!_channelRegistered && typeof api.registerChannel === "function") {
      try {
        // ChannelPlugin requires a `config` adapter even for outbound-only
        // plugins: openclaw's listConfiguredMessageChannels iterates every
        // registered plugin and calls plugin.config.listAccountIds(cfg) when
        // resolving the default delivery channel. Without it we'd crash any
        // auto-resolution path. Read from the same path iOS writes to —
        // `plugins.entries.onepilot.config.accounts` — so the adapter sees
        // the live config, not the snapshot captured at register() time.
        const readAccounts = (cfg) =>
          cfg?.plugins?.entries?.onepilot?.config?.accounts ??
          cfg?.plugins?.entries?.onepilot?.accounts ??
          {};

        api.registerChannel({
          plugin: {
            id: "onepilot",
            meta: {
              id: "onepilot",
              label: "Onepilot",
              description: "Delivers to the Onepilot iOS app via Supabase.",
            },
            config: {
              listAccountIds: (cfg) => Object.keys(readAccounts(cfg)),
              resolveAccount: (cfg, accountId) => {
                const a = readAccounts(cfg)[accountId];
                return a ? { accountId, ...a } : null;
              },
              isEnabled: (account) => account?.enabled !== false,
              // Onepilot routing is fully baked into the account config
              // (userId + agentProfileId + sessionKey) — there's no per-
              // recipient address like a phone number. When the outbound
              // dispatcher asks for a default target (e.g. cron jobs
              // created without `--to`), hand back the account's
              // sessionKey. Otherwise openclaw throws
              // "Delivering to Onepilot requires target" before sendText
              // is ever invoked. (See openclaw/src/infra/outbound/targets.ts:223.)
              resolveDefaultTo: ({ cfg, accountId }) => {
                const accounts = readAccounts(cfg);
                const id = accountId ?? Object.keys(accounts)[0];
                return accounts[id]?.sessionKey ?? "main";
              },
            },
            outbound: {
              deliveryMode: "direct",
              sendText: (ctx) =>
                sendOnepilotText({
                  ctx,
                  accounts,
                  log: (m, err) => {
                    if (err) api.logger.warn?.(`[onepilot:outbound] ${m}: ${String(err)}`);
                    else api.logger.info?.(`[onepilot:outbound] ${m}`);
                  },
                }),
            },
          },
        });
        _channelRegistered = true;
        log("registered outbound channel `onepilot`");
      } catch (err) {
        warn("registerChannel failed — cron delivery will not work", err);
      }
    } else if (typeof api.registerChannel !== "function") {
      warn("api.registerChannel unavailable — OpenClaw too old? cron delivery will not work");
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
      for (const field of ["supabaseUrl", "supabaseAnonKey", "userId", "agentProfileId", "sessionKey"]) {
        if (!account?.[field]) missing.push(field);
      }
      // Auth: `pluginJwt` (long-lived per-agent JWT minted by the
      // mint-plugin-jwt edge function) is the preferred credential — it
      // avoids the shared-session refresh_token rotation race that wedged
      // multi-agent setups. `userRefreshToken` is still accepted for
      // backwards compatibility with installs that predate the switch.
      if (!account?.pluginJwt && !account?.userRefreshToken) {
        missing.push("pluginJwt or userRefreshToken");
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

      // Shared access-token state for Realtime (auth) and messaging (REST).
      // With `pluginJwt` set, the token is static — no refresh flow needed.
      let cachedAccessToken = account.pluginJwt ?? null;
      const getAccessToken = () => {
        if (cachedAccessToken) return Promise.resolve(cachedAccessToken);
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
        staticAccessToken: account.pluginJwt,
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
