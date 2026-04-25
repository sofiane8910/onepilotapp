// Onepilot plugin for OpenClaw.
//
// Bridges Onepilot app messages to OpenClaw's agent runtime and writes
// agent replies back so the app can receive them via push notification.
//
// Architecture:
//   1. App writes user row through the backend.
//   2. This plugin (running inside the gateway process) receives the new
//      message event over the inbound channel.
//   3. Plugin calls http://127.0.0.1:<gatewayPort>/v1/chat/completions locally.
//      The caller is the gateway itself, so there's no external client that can
//      disconnect — the LLM call always runs to completion, regardless of the
//      app's lifecycle (this is why force-quit works).
//   4. Plugin posts the reply back through the message endpoint.
//   5. A backend trigger fires the push notification to the app.

import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { startStreamSubscription } from "./stream.js";
import { handleUserMessage } from "./messaging.js";
import { sendOnepilotText } from "./outbound.js";

// Module-level dedupe. OpenClaw calls `register` multiple times per gateway
// lifetime (once per registration mode, plus re-registrations after config
// changes). If we create a new channel subscription per call, we get
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
  description: "Bridges Onepilot messages to OpenClaw agents.",
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

    if (!_channelRegistered && typeof api.registerChannel === "function") {
      try {
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
              description: "Delivers to the Onepilot app.",
            },
            config: {
              listAccountIds: (cfg) => Object.keys(readAccounts(cfg)),
              resolveAccount: (cfg, accountId) => {
                const a = readAccounts(cfg)[accountId];
                return a ? { accountId, ...a } : null;
              },
              isEnabled: (account) => account?.enabled !== false,
              resolveDefaultTo: ({ cfg, accountId }) => {
                const entries = readAccounts(cfg);
                const id = accountId ?? Object.keys(entries)[0];
                return entries[id]?.sessionKey ?? "main";
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
      for (const field of ["backendUrl", "streamUrl", "publishableKey", "agentKey", "userId", "agentProfileId", "sessionKey"]) {
        if (!account?.[field]) missing.push(field);
      }
      if (missing.length > 0) {
        warn(`[${accountId}] missing required config fields: ${missing.join(", ")}`);
        continue;
      }

      log(
        `[${accountId}] starting inbound channel subscription ` +
          `user=${String(account.userId).slice(0, 8)} ` +
          `agent=${String(account.agentProfileId).slice(0, 8)}`,
      );

      // Lowercase the routing IDs once. iOS sends uppercase UUIDs (Swift's
      // default) but the backend stores the canonical lowercase form.
      const userIdLc = String(account.userId).toLowerCase();
      const agentProfileIdLc = String(account.agentProfileId).toLowerCase();

      const sub = startStreamSubscription({
        accountId,
        backendUrl: account.backendUrl,
        streamUrl: account.streamUrl,
        publishableKey: account.publishableKey,
        agentKey: account.agentKey,
        userId: userIdLc,
        schema: "public",
        table: "messages",
        filter: `user_id=eq.${userIdLc}`,
        // Evict on terminal auth failure (agent key revoked). iOS must
        // re-pair the agent to get a new key; when that config lands via
        // hot-reload, register() creates a fresh subscription.
        onTerminal: ({ reason }) => {
          _activeSubscriptions.delete(accountId);
          warn(`[${accountId}] channel auth permanently failed, evicted — awaiting re-pair`);
          warn(`[${accountId}] reason: ${reason}`);
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
            log: (m, err) => {
              if (err) api.logger.warn?.(`[onepilot:${accountId}:dispatch] ${m}: ${String(err)}`);
              else api.logger.info?.(`[onepilot:${accountId}:dispatch] ${m}`);
            },
          });
        },
        log: (m, err) => {
          if (err) api.logger.warn?.(`[onepilot:${accountId}:stream] ${m}: ${String(err)}`);
          else api.logger.info?.(`[onepilot:${accountId}:stream] ${m}`);
        },
      });

      _activeSubscriptions.set(accountId, sub);
      subscriptions.push({ accountId, sub });
    }

    log(`${subscriptions.length} subscription(s) active`);
  },
});
