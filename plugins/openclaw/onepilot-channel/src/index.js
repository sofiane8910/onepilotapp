// Onepilot plugin for OpenClaw — bridges app messages to/from the agent.

import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { startStreamSubscription } from "./stream.js";
import { handleUserMessage } from "./messaging.js";
import { sendOnepilotText } from "./outbound.js";

// One subscription / channel registration per process — register() can fire
// multiple times and we need to dedupe to avoid duplicate inserts.
const _activeSubscriptions = new Map();
let _channelRegistered = false;

async function runCatchUp({ account, agentProfileIdLc, sinceMs, log, dispatch }) {
  try {
    const url = `${account.backendUrl}/functions/v1/agent-message-history?mode=recent-user&minutes=10&limit=20`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${account.agentKey}` },
    });
    if (!res.ok) {
      const body = await res.text();
      log(`history fetch failed: ${res.status} ${body.slice(0, 200)}`);
      return;
    }
    const json = await res.json();
    const rows = Array.isArray(json?.messages) ? json.messages : [];
    let dispatched = 0;
    for (const row of rows) {
      if (
        agentProfileIdLc &&
        row.agent_profile_id &&
        String(row.agent_profile_id).toLowerCase() !== agentProfileIdLc
      ) continue;
      const ts = row.created_at ? Date.parse(row.created_at) : 0;
      if (!Number.isFinite(ts) || ts <= sinceMs) continue;
      dispatch(row);
      dispatched++;
    }
    if (dispatched > 0) log(`recovered ${dispatched} missed message(s) on (re)subscribe`);
  } catch (err) {
    log(`catch-up failed`, err);
  }
}

export default definePluginEntry({
  id: "onepilot",
  name: "Onepilot",
  description: "Bridges Onepilot messages to OpenClaw agents.",
  // register MUST be synchronous; async work is fire-and-forget.
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

      // Lowercase routing IDs — backend stores canonical lowercase UUIDs.
      const userIdLc = String(account.userId).toLowerCase();
      const agentProfileIdLc = String(account.agentProfileId).toLowerCase();

      // Catch-up high-water mark: highest user-message ts we've dispatched.
      // On every (re)subscribe we ask the backend for newer rows to recover
      // anything that landed during a Realtime gap (broadcast-only, no replay).
      let lastSeenUserAt = 0;
      const catchUpInFlight = { value: false };

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
          const ts = row.created_at ? Date.parse(row.created_at) : 0;
          if (Number.isFinite(ts) && ts > lastSeenUserAt) lastSeenUserAt = ts;
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
        onSubscribed: () => {
          if (catchUpInFlight.value) return;
          catchUpInFlight.value = true;
          void runCatchUp({
            account,
            agentProfileIdLc,
            sinceMs: lastSeenUserAt,
            log: (m, err) => {
              if (err) api.logger.warn?.(`[onepilot:${accountId}:catchup] ${m}: ${String(err)}`);
              else api.logger.info?.(`[onepilot:${accountId}:catchup] ${m}`);
            },
            dispatch: (row) => {
              const ts = row.created_at ? Date.parse(row.created_at) : 0;
              if (Number.isFinite(ts) && ts > lastSeenUserAt) lastSeenUserAt = ts;
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
          }).finally(() => { catchUpInFlight.value = false; });
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
