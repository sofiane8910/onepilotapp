# hermes-onepilot-platform

A plugin for the [Hermes](https://github.com/NousResearch/hermes-agent) agent framework that bridges Onepilot app messages to a Hermes gateway and posts assistant replies back so the Onepilot app can deliver them as push notifications, even when the app is closed.

## What it does

When a Hermes profile has the `onepilot` plugin enabled:

- Subscribes to the inbound channel for this user's messages.
- On a user message, calls Hermes' OpenAI-compatible API server (running in the same gateway process at `http://127.0.0.1:<API_SERVER_PORT>/v1/chat/completions`) to produce a reply.
- Posts the reply to the backend message endpoint, which inserts the row and delivers a push notification to the user's devices.

The plugin runs inside the Hermes gateway's asyncio event loop. There is no separate process: when the gateway is up, the plugin is up; when the gateway crashes and restarts, so does the plugin.

## Layout

```
plugin.yaml      # Hermes plugin manifest
__init__.py      # register(ctx) entry point + asyncio bridge
config.json      # runtime config (written by the deploy step, not committed)
```

## Install

The Onepilot iOS app installs this plugin automatically when a user picks "Onepilot Chat" as the channel for their Hermes agent. The deploy step:

1. Writes `plugin.yaml` and `__init__.py` to `<HERMES_HOME>/plugins/onepilot/`.
2. Mints a per-agent API key and writes `config.json` (mode 600) with the backend URLs and credentials the plugin needs.
3. Adds `onepilot` to `plugins.enabled` in the profile's `config.yaml`.
4. Sets `platforms.api_server.enabled: true` (the plugin self-fetches the local API server).
5. Restarts the gateway so the plugin is discovered.

## Auth model

A durable per-agent API key (server-bound to one `(user_id, agent_profile_id)` pair) lives in `config.json`. The plugin exchanges it for short-lived stream JWTs on demand. A leaked key cannot post into another user's inbox or read another agent's history — server-side checks reject any request whose body claims a different user or agent than the key is bound to.

The Onepilot app can rotate the key at any time (a fresh mint atomically revokes the prior hash) or revoke it outright.

## Reliability

- Plugin lives in-process with the Hermes gateway: no extra PID to supervise.
- Inbound subscription auto-reconnects with exponential backoff.
- Stream JWTs are renewed proactively before expiry.
- Long agent runs do not time out: the plugin's caller and the LLM caller are the same process.
- A foreground app reply (when the user has the Onepilot app open and a server-side path already produced a reply) is detected and de-duplicated so the user never sees two assistant turns for one prompt.

## Config

The deploy step writes `config.json` next to `__init__.py`. Fields:

| Field | Meaning |
|---|---|
| `enabled` | Master switch. Plugin idles cleanly if `false`. |
| `backendUrl` | Base URL for HTTP endpoints (`/functions/v1/...`). |
| `streamUrl` | Base URL for the inbound channel websocket. |
| `publishableKey` | Channel-server `apikey` query parameter. |
| `agentKey` | Durable per-agent credential (`oak_…`). |
| `userId` | Onepilot user this agent serves. |
| `agentProfileId` | Onepilot agent profile this plugin belongs to. |
| `sessionKey` | Default session routing key. |

## License

MIT
