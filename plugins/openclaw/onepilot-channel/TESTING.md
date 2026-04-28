# Onepilot OpenClaw Plugin — End-to-End Test Sheet

Everything in this sheet requires the mobile app to run against a real agent host (Docker, Mac Mini, or remote VPS). Every step notes **what logs to collect** to confirm success.

## Pre-test state reset

On the agent host you're testing against:

```sh
# 1. Uninstall the plugin if it's already installed (pristine start).
openclaw --profile <agent-id> plugins uninstall onepilot

# 2. Clear any stale config under our plugin path.
openclaw --profile <agent-id> config unset plugins.entries.onepilot

# 3. Clear the state dir the deploy writes to.
rm -rf ~/.openclaw-<agent-id>/plugins/openclaw-onepilot-channel

# 4. Restart the gateway so it starts from a clean plugin registry.
pkill -f 'openclaw.*gateway'
# (The app will auto-start on next connect via its self-heal.)
```

## Test 1 — Deploy from the app plants the plugin

**Do**: re-deploy the agent from the "Deploy" / "Fix" flow in the AgentDetailView.

**Expect** (mobile console, filter subsystem `com.onepilot.app`):

```
[OpenClaw] [plugin-deploy] agent=<id> dir=~/.openclaw-<id>/plugins/openclaw-onepilot-channel
[OpenClaw] [plugin-deploy] writing package.json
[OpenClaw] [plugin-deploy] writing openclaw.plugin.json
[OpenClaw] [plugin-deploy] writing src/index.js
[OpenClaw] [plugin-deploy] writing src/stream.js
[OpenClaw] [plugin-deploy] writing src/messaging.js
[OpenClaw] [plugin-deploy] registering plugin via `plugins install`
[OpenClaw] [plugin-deploy] plugin installed: Installed plugin: onepilot
[OpenClaw] [plugin-deploy] account config written (user=<prefix>, agent=<prefix>)
[OpenClaw] [plugin-deploy] done agent=<id>
```

**Verify on agent host**:

```sh
ssh <host> openclaw --profile <agent-id> plugins list | grep onepilot
# Expect: onepilot | openclaw | loaded | managed | 0.3.0

ssh <host> openclaw --profile <agent-id> config get plugins.entries.onepilot
# Expect: { "enabled": true, "config": { "accounts": { "default": {
#   ... "agentKey": "__OPENCLAW_REDACTED__" } } } }
```

## Test 2 — Plugin boots with live inbound channel

**Do**: restart gateway (app auto-restarts on reconnect, or `pkill` and let it self-heal).

**Expect** (gateway log, e.g. `docker exec ssh-test tail /tmp/openclaw-test.log`):

```
[plugins] [onepilot] plugin registered — 1 account(s) configured: default
[plugins] [onepilot] [default] starting inbound channel subscription user=<prefix> agent=<prefix>
[plugins] [onepilot] 1 subscription(s) active
[plugins] [onepilot:default:stream] auth token minted (exp in XXXXs)
[plugins] [onepilot:default:stream] socket open, joining channel
```

If the agent key was revoked, you'll see the channel evict itself and go quiet:

```
[plugins] [onepilot:default:stream] agent key invalidated — channel idle until re-paired
[plugins] [onepilot] [default] channel auth permanently failed, evicted — awaiting re-pair
```

— re-pair the agent from the app to issue a fresh key.

## Test 3 — Foreground chat: no regression

**Do**: open the app, tap into a chat, send "hello". Watch the typing animation.

**Expect**: streaming works as today. Typing indicator shows, then assistant reply streams.

**Expect (messages table)**: one `role='user' source='app'` row, one `role='assistant' source='app'` row. The plugin's dedupe probe should log:

```
[plugins] [onepilot:default:dispatch] session <prefix> already has an assistant reply — skipping
```

**Confirms**: foreground UX unchanged, no duplicate LLM calls.

## Test 4 — Force-quit survives (the main event)

**Do**:
1. Open a chat.
2. Type "Tell me a short story".
3. Tap send.
4. **Immediately swipe up to force-quit the app** (before the first streamed chunk arrives).
5. Wait ~30 seconds.
6. Phone should buzz with a push notification.
7. Tap the push.

**Expect** (gateway log):

```
[plugins] [onepilot] [default] user message id=<prefix> session=main — dispatching to agent
[plugins] [onepilot:default:dispatch] calling gateway with N message(s) in history
[plugins] [onepilot:default:dispatch] assistant reply delivered (NNN chars)
```

**Expect on re-open**: the story is already in the chat, no loading state, no missing reply.

## Test 5 — App backgrounded (pressed Home, didn't force-quit)

**Do**:
1. Open a chat.
2. Send "what time is it".
3. Press Home (don't swipe-kill).
4. Wait ~15 seconds.

**Expect**: push notification arrives, reply is in the chat when you reopen.

## Test 6 — Gateway crash recovery

**Do**:
1. `pkill -9 openclaw-gateway` on the host.
2. From the app, open a chat (triggers self-heal).
3. Send a message.

**Expect**: everything works as in Test 3.

## Test 7 — Auth-token renew survives over time

**Do**:
1. Deploy plugin.
2. Force-quit app.
3. Leave the gateway running for 24 hours.
4. Send a message from the app.

**Expect**: plugin re-mints the short-lived auth token transparently on expiry. Log shows:

```
[plugins] [onepilot:default:stream] auth token minted (exp in XXXXs)
[plugins] [onepilot:default:stream] pushed renewed auth token to channel
```

No reconnect loops. No "invalidated" messages. The durable agent key never rotates — only the 1h auth token does, and it re-mints cleanly.

## Test 8 — Multi-agent collision test (regression for the pre-v0.3.0 wedge)

**Do**:
1. Deploy two agents (`hh` and `yggdrasil`) under the same user account, same mobile install.
2. Leave both running for 24h without touching the app.
3. Send a message to each agent.

**Expect**: both reply healthily. `consecutiveErrors` on each agent's cron state stays 0. Neither plugin wedges.

This is the regression gate for the bug that motivated the v0.3.0 durable-key rewrite — two agents used to race on a shared auth chain and one would wedge permanently after a few hours.

## Test 9 — Key revocation from the app

**Do**:
1. From the app's agent-detail debug section, tap "Revoke agent key".
2. Watch the gateway log.

**Expect**: the plugin's next auth-token fetch returns 401 revoked; plugin goes quiet:

```
[plugins] [onepilot:default:stream] agent key invalidated — channel idle until re-paired
```

**Then**: tap "Pair agent" to re-issue a fresh key. Plugin resumes normally.

## Test 10 — Multi-host smoke

Run Tests 1–6 against each supported host (Docker, Mac Mini, VPS). Compare log outputs.

## Rollback plan

If the plugin misbehaves in production and we need to disable it without re-releasing the app:

```sh
ssh <host> openclaw --profile <agent-id> plugins uninstall onepilot
ssh <host> 'pkill -f openclaw.*gateway'  # app restarts it on next connect
```

## Logging cheat sheet

| Where | How to read |
|---|---|
| Mobile app | Xcode console, filter `subsystem:com.onepilot.app category:OpenClaw` |
| Plugin (gateway) | `docker exec ssh-test tail -f /tmp/openclaw/openclaw-*.log` (or `~/.openclaw/logs/` on Mac Mini) |
| Plugin stdout | `tail -f /tmp/openclaw-<profile>.log` — contains `[plugins] [onepilot]` lines |
| Backend edge function | (internal log-inspection tooling on the maintainer's side) |
| Push delivery | Push-notify function logs show `sent: 1, total: 1` on success |
