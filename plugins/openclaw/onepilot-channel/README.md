# openclaw-onepilot-channel

OpenClaw plugin that bridges the Onepilot app to the agent runtime. Two responsibilities, both running inside the OpenClaw gateway process on the agent host:

1. **Inbound** — opens a durable channel to the Onepilot backend, listens for new user-message events, dispatches them into the agent loop via the gateway's local `/v1/chat/completions` endpoint, and POSTs the assistant reply back to the Onepilot backend so the app receives it via push. Survives mobile force-quits because the agent loop never depends on the app staying alive.
2. **Outbound channel** — registers `onepilot` as a real OpenClaw channel (`api.registerChannel`). This is what makes cron jobs (and any other agent-driven outbound delivery) work — without a registered channel, OpenClaw's delivery resolver throws `"channel is required"` at fire-time. The channel's `sendText` reuses the same backend message endpoint the inbound reply flow uses.

## Repository layout

```
openclaw-onepilot-channel/
├── README.md            ← you are here
├── TESTING.md           ← end-to-end test sheet (foreground, force-quit, push, etc.)
├── package.json         ← npm metadata; `version` is the source of truth for releases
├── openclaw.plugin.json ← plugin manifest read by OpenClaw at install time
└── src/
    ├── index.js         ← register() hook: wires channel subscription + registers outbound
    ├── stream.js        ← inbound channel client over our raw WS (see ws-raw.js)
    ├── messaging.js     ← inbound dispatch: user message → agent loop → reply POST
    ├── outbound.js      ← outbound channel handler: cron / agent reply → backend
    ├── env.js           ← isolated runtime env reader (scanner-safe)
    ├── constants.js     ← shared user-agent string
    └── ws-raw.js        ← node:https-based WebSocket (built-in WebSocket is broken
                            inside the gateway process — see file header)
```

## Credential model

Each deployed agent holds its own **durable API key** (`agentKey`, prefix `oak_`). The app provisions one at pair time, the backend stores only an argon2id hash, and the raw key lives forever until the app revokes it. The plugin uses the key to:

- Exchange it on demand for a short-lived channel auth token (1h TTL). No rotation chain, no shared session state — each exchange is independent.
- Authenticate outbound message POSTs directly (the backend binds the key to `(userId, agentProfileId)` server-side).

Because nothing rotates and nothing is shared across agents, two gateways on the same user account can never collide on credentials. A key wedge is impossible.

## Configuring an account

Provisioned automatically by the app's deploy flow. Manual form:

```sh
openclaw --profile <agent-id> config set 'plugins.entries.onepilot.config.accounts.default' '{
  "enabled": true,
  "backendUrl": "https://api.onepilotapp.com",
  "streamUrl": "wss://api.onepilotapp.com",
  "publishableKey": "<publishable key>",
  "agentKey": "oak_...",
  "userId": "<uuid>",
  "agentProfileId": "<uuid>",
  "sessionKey": "main"
}'
```

## Distribution flow

We **do not** embed plugin source in the mobile binary. Plugin updates ship independently of App Store review.

```
┌────────────────────────┐      ┌──────────────────────┐      ┌─────────────────────┐
│  GitHub Release        │      │  plugin_manifest     │      │  Mobile app         │
│  sofiane8910/          │◀─────│  (channel='stable')  │─────▶│  PluginManifest     │
│  onepilotapp/releases  │      │  → version           │      │  Fetcher.fetch()    │
│                        │      │  → tarball_url       │      │                     │
│  onepilot-channel-     │      │  → sha256            │      │  ssh-installs over  │
│  v0.X.Y.tgz            │      │                      │      │  curl + sha256      │
└────────────────────────┘      └──────────────────────┘      │  + tar -xzf         │
                                                              └─────────────────────┘
```

1. Tag a release on `sofiane8910/onepilotapp` and attach the tgz tarball.
2. `UPDATE` the `plugin_manifest` row to point `tarball_url` and `sha256` at the new release.
3. On next agent deploy, the app reads the manifest, SSH-runs an install script on the agent host that `curl`s the tarball, verifies the sha256 inline (mismatch → abort, no files written), and `tar -xzf` into `~/.openclaw-<agentId>/plugins/openclaw-onepilot-channel/`, then runs `openclaw plugins install <dir> --link`.
4. The manifest row is the version pin — bump it whenever you want a new build to roll out.

The mobile-side reader is `ios/Sources/Onepilot/Models/Agent/Adapters/PluginManifestFetcher.swift`. The install flow lives in `OpenClawAdapter.swift` (`deployOnepilotChannelPlugin` → `installPluginFromRelease` → `buildUnixInstallScript` / `buildWindowsInstallScript`).

## Cutting a new version

See `CLAUDE.md` in this directory (gitignored) for the release pipeline — the published tarball is built from a separate repo, and forgetting the sync step is a known footgun.

## Rollback

If a release misbehaves, revert the `plugin_manifest` row to a known-good version and (optionally) yank the bad release. Existing agents won't downgrade automatically (the install script is a no-op when the installed version matches the manifest), but new deploys and reinstalls will pick up the rollback.

## See also

- `TESTING.md` — end-to-end test plan (foreground chat, force-quit, push dedup, multi-host).
- `/openclaw/` (in this monorepo) — upstream OpenClaw source. **Do not modify.**
- `ios/Sources/Onepilot/Models/Agent/Adapters/OpenClawAdapter.swift` — the deploy/install code.
- `ios/Sources/Onepilot/Models/Agent/Adapters/PluginManifestFetcher.swift` — manifest reader.
