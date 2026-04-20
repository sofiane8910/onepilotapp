# openclaw-onepilot-channel

OpenClaw plugin that bridges the Onepilot iOS app to the agent runtime. Two responsibilities, both running inside the OpenClaw gateway process on the agent host:

1. **Inbound** — listens to Supabase Realtime for new user-message rows, dispatches them into the agent loop via the gateway's local `/v1/chat/completions` endpoint, and POSTs the assistant reply to the `openclaw-message-ingest` edge function so iOS receives it through Realtime + APNs push. Survives iOS force-quits because the agent loop never depends on the iOS side staying alive.
2. **Outbound channel** — registers `onepilot` as a real OpenClaw channel (`api.registerChannel`). This is what makes cron jobs (and any other agent-driven outbound delivery) work — without a registered channel, OpenClaw's delivery resolver throws `"channel is required"` at fire-time. The channel's `sendText` reuses the same Supabase ingest path the inbound reply flow uses.

## Repository layout

```
openclaw-onepilot-channel/
├── README.md            ← you are here
├── TESTING.md           ← end-to-end test sheet (foreground, force-quit, push, etc.)
├── package.json         ← npm metadata; `version` is the source of truth for releases
├── openclaw.plugin.json ← plugin manifest read by OpenClaw at install time
└── src/
    ├── index.js         ← register() hook: wires Realtime + registers `onepilot` channel
    ├── realtime.js      ← Supabase Realtime client over our raw WS (see ws-raw.js)
    ├── messaging.js     ← inbound dispatch: user row → agent loop → reply ingest
    ├── outbound.js      ← outbound channel handler: cron / agent reply → ingest
    ├── constants.js     ← shared WEBHOOK_AUTH_KEY (mirrors OpenClawAdapter.swift)
    └── ws-raw.js        ← node:https-based WebSocket (built-in WebSocket is broken
                            inside the gateway process — see file header)
```

## Distribution flow (how iOS installs this plugin)

We **do not** embed plugin source in the iOS binary. Plugin updates ship independently of App Store review.

```
┌────────────────────────┐      ┌──────────────────────┐      ┌─────────────────────┐
│  GitHub Release        │      │  Supabase            │      │  iOS app            │
│  sofiane8910/          │◀─────│  public.             │─────▶│  PluginManifest     │
│  onepilotapp/releases  │      │  plugin_manifest     │      │  Fetcher.fetch()    │
│  v0.X.Y/               │      │  (channel='stable')  │      │                     │
│  onepilot-channel-     │      │  → version           │      │  ssh-installs over  │
│  v0.X.Y.tgz            │      │  → tarball_url       │      │  curl + sha256      │
└────────────────────────┘      │  → sha256            │      │  + tar -xzf         │
                                └──────────────────────┘      └─────────────────────┘
```

1. We tag a release on `sofiane8910/onepilotapp` and attach the tgz tarball.
2. We `UPDATE` the row in Supabase `public.plugin_manifest` to point `tarball_url` and `sha256` at the new release.
3. On the next agent deploy, iOS reads the manifest, SSH-runs an install script on the agent host that `curl`s the tarball, verifies the sha256 inline (mismatch → abort, no files written), and `tar -xzf` into `~/.openclaw-<agentId>/plugins/openclaw-onepilot-channel/`, then runs `openclaw plugins install <dir> --link`.
4. The Supabase row is the version pin — bump it whenever you want a new build to roll out.

iOS reads the manifest in `ios/Sources/Onepilot/Models/Agent/Adapters/PluginManifestFetcher.swift`. The install flow lives in `OpenClawAdapter.swift` (`deployOnepilotChannelPlugin` → `installPluginFromRelease` → `buildUnixInstallScript` / `buildWindowsInstallScript`).

## Cutting a new version

```sh
# 1. Bump the version in package.json
#    Use semver. Patch for bugfix, minor for additive changes, major for breaking.

# 2. Pack
cd openclaw-onepilot-channel
VERSION=$(node -p "require('./package.json').version")
npm pack                                              # → openclaw-onepilot-channel-<VERSION>.tgz
mv openclaw-onepilot-channel-${VERSION}.tgz onepilot-channel-v${VERSION}.tgz

# 3. Compute sha256
SHA=$(shasum -a 256 onepilot-channel-v${VERSION}.tgz | awk '{print $1}')
echo "sha256=$SHA"

# 4. Cut the GitHub release
gh release create v${VERSION} \
  onepilot-channel-v${VERSION}.tgz \
  --repo sofiane8910/onepilotapp \
  --title "openclaw-onepilot-channel v${VERSION}" \
  --notes "See https://github.com/sofiane8910/terminal_agent for changelog."

# 5. Roll it out: UPDATE the Supabase manifest row
#    Use the supabase_onepilot MCP (project id eyfayueqafznhppbufub):
#    UPDATE public.plugin_manifest
#       SET version='${VERSION}',
#           tarball_url='https://github.com/sofiane8910/onepilotapp/releases/download/v${VERSION}/onepilot-channel-v${VERSION}.tgz',
#           sha256='${SHA}',
#           updated_at=now()
#     WHERE channel='stable';
```

After step 5, every agent picks up the new plugin on its next deploy (or on next gateway restart if you trigger a redeploy from the iOS Debug section).

## Configuring an account

Provisioned automatically by the iOS deploy flow. Manual form:

```sh
openclaw --profile <agent-id> config set 'plugins.entries.onepilot.config.accounts.default' '{
  "enabled": true,
  "supabaseUrl": "https://<project>.supabase.co",
  "supabaseAnonKey": "<anon key>",
  "userId": "<uuid>",
  "agentProfileId": "<uuid>",
  "sessionKey": "main",
  "pluginJwt": "<long-lived JWT minted by mint-plugin-jwt edge function>"
}'
```

`pluginJwt` is preferred over `userRefreshToken` (avoids the shared-session refresh-token rotation race). iOS mints it at deploy time.

## Why outbound goes through the same Supabase ingest endpoint

Both inbound replies (`messaging.js`) and outbound channel sends (`outbound.js`) POST to the `openclaw-message-ingest` edge function with the shared `WEBHOOK_AUTH_KEY`. That function writes the row to `public.messages`, which fires the push-notify trigger → APNs. By reusing the pipe:

- **One write path** to Supabase, one push pipeline, one place to debug.
- **No client coupling** — the agent host doesn't need iOS-specific SDK code; it just needs `fetch` and the shared secret.
- **Cron delivery works the same as a normal reply** — an iOS user can't tell whether a message was scheduled or freshly generated.

## Rollback

If a release misbehaves, revert the manifest row to a known-good version and (optionally) yank the bad release:

```sql
UPDATE public.plugin_manifest
   SET version='<previous>',
       tarball_url='https://github.com/sofiane8910/onepilotapp/releases/download/v<previous>/onepilot-channel-v<previous>.tgz',
       sha256='<previous sha>',
       updated_at=now()
 WHERE channel='stable';
```

Existing agents won't downgrade automatically (the install script is a no-op when the installed version matches the manifest), but new deploys and reinstalls will pick up the rollback. To force a redowngrade, run "Reinstall plugin" from the iOS Debug → self-heal section.

## See also

- `TESTING.md` — end-to-end test plan (foreground chat, force-quit, push dedup, refresh-token rotation, multi-host).
- `/openclaw/` (in this monorepo) — upstream OpenClaw source. **Do not modify.**
- `ios/Sources/Onepilot/Models/Agent/Adapters/OpenClawAdapter.swift` — the iOS deploy/install code.
- `ios/Sources/Onepilot/Models/Agent/Adapters/PluginManifestFetcher.swift` — Supabase manifest reader.
