# OpenClaw — Onepilot channel

OpenClaw plugin that bridges the Onepilot app to the agent runtime. Two responsibilities, both running inside the OpenClaw gateway process on the agent host:

1. **Inbound** — listens for new user messages on the sync bus, dispatches them into the agent loop via the gateway's local `/v1/chat/completions` endpoint, and posts the assistant reply back so the phone receives it. Survives mobile force-quits because the agent loop never depends on the phone staying alive.
2. **Outbound channel** — registers `onepilot` as a real OpenClaw channel (`api.registerChannel`). This is what makes cron jobs (and any other agent-driven outbound delivery) work — without a registered channel, OpenClaw's delivery resolver throws `"channel is required"` at fire-time. The channel's `sendText` reuses the same ingest path the inbound reply flow uses.

## Layout

```
onepilot-channel/
├── README.md            ← you are here
├── package.json         ← npm metadata; `version` drives releases
├── openclaw.plugin.json ← manifest read by OpenClaw at install time
└── src/
    ├── index.js         ← register() hook: wires sync subscription + registers `onepilot` channel
    ├── realtime.js      ← sync-bus client
    ├── messaging.js     ← inbound dispatch: user message → agent loop → reply ingest
    ├── outbound.js      ← outbound channel handler: cron / agent reply → ingest
    ├── constants.js     ← shared constants
    └── ws-raw.js        ← low-level WebSocket (built-in is broken inside the gateway process)
```

## How it's distributed

The plugin is not embedded in the Onepilot app binary. Releases ship independently — any user running the app gets the latest compatible version pulled onto their agent host automatically on next deploy.

See the [repo root README](../../../README.md) for the release pipeline and tag convention.

## Configuring an account

Provisioned automatically by the Onepilot deploy flow. For a manual sanity check:

```sh
openclaw --profile <agent-id> config set 'plugins.entries.onepilot.config.accounts.default' '{
  "enabled": true,
  "syncUrl": "<provisioned>",
  "syncKey": "<provisioned>",
  "userId": "<uuid>",
  "agentProfileId": "<uuid>",
  "sessionKey": "main",
  "pluginJwt": "<long-lived JWT>"
}'
```

*(Field names accepted by the plugin may still include legacy aliases — look at `openclaw.plugin.json` for the current schema.)*

`pluginJwt` is the preferred credential; it avoids the shared-session token rotation race.

## Why inbound replies and outbound sends share one endpoint

Both `messaging.js` (inbound → reply) and `outbound.js` (cron / proactive → send) post through the same ingest endpoint. Benefits:

- One write path, one notification pipeline, one place to debug.
- No client coupling — the agent host doesn't need the phone's SDK; `fetch` is enough.
- Cron delivery is indistinguishable from a normal reply to the user.

## Rollback

If a release misbehaves, revert the backend manifest to a previous version. Existing agents won't auto-downgrade; new deploys and manual reinstalls will pick up the rollback.

## Contributing

See the [repo root README](../../../README.md) for how to ship a plugin. Issues and PRs welcome.
