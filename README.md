<div align="center">

<img src="docs/img/pillars.svg" alt="Onepilot — modern mobile terminal + AI agent ops" width="100%"/>

# Onepilot

### The mobile terminal for modern developers — with an AI agent layer built in.

[**Download on onepilotapp.com →**](https://onepilotapp.com)

[![iOS](https://img.shields.io/badge/iOS-15%2B-black.svg?style=flat-square&logo=apple)](https://onepilotapp.com)
[![App Store](https://img.shields.io/badge/App%20Store-get-blue.svg?style=flat-square&logo=app-store&logoColor=white)](https://onepilotapp.com)
[![Plugins: MIT](https://img.shields.io/badge/plugins-MIT-blue.svg?style=flat-square)](./LICENSE)
[![Plugins live](https://img.shields.io/badge/plugins-1%20live%20%C2%B7%202%20next-brightgreen.svg?style=flat-square)](#supported-frameworks)
[![Stars](https://img.shields.io/github/stars/sofiane8910/onepilotapp?style=flat-square)](https://github.com/sofiane8910/onepilotapp/stargazers)

</div>

---

**Termius and Blink stop at the prompt.** Onepilot doesn't.

You get a real SSH terminal — and around it, the rest of the modern dev workflow on mobile: live file editing on the remote box, in-app `localhost:3000` preview, GitHub PRs and Actions, cron monitoring, a directory picker. Then a second pillar on top: a one-tap AI agent ops layer so you can spin up an agent on your server in under a minute and chat with it from your phone.

> **One app. Two pillars. Your phone becomes the workstation.**

<div align="center">

### [→ Get Onepilot at onepilotapp.com](https://onepilotapp.com)

</div>

<br>

## What's in the app

<img src="docs/img/feature-grid.svg" alt="Onepilot features" width="100%"/>

<br>

## Why this exists

Mobile SSH apps have been frozen in 2014. They give you a prompt and call it done. But modern development isn't just typing into a shell — it's editing files, previewing localhost, reviewing PRs, watching crons, talking to agents. Onepilot is what happens when you build the **whole loop** for the phone instead of just the terminal pane.

The agent layer comes from the same observation: running an AI agent on your server today means SSH'ing in to edit YAML, then setting up a Telegram bot to talk to it. Onepilot collapses that to a guided wizard and an in-app chat.

> **We did not build [OpenClaw](https://github.com/openclaw/openclaw).** OpenClaw is a third-party open-source agent runtime. Onepilot integrates with it and adds the orchestration layer that's missing — deployment, monitoring, mobile chat, push.

<br>

## The repo: framework adapter pool

<img src="docs/img/frameworks.svg" alt="Framework adapter layer" width="100%"/>

This repo is the **public plugin pool** that powers Onepilot's agent pillar. Every agent framework we integrate with ships its adapter here. When you pair a server in the app, the right adapter is fetched automatically.

> **Drop-in integration.** If you run an agent framework, you get a free iOS front-end. No SDK to learn, no UI to build.

<br>

## Supported frameworks

| Framework | Plugin | Status | What it adds to Onepilot |
|---|---|---|---|
| [**OpenClaw**](https://github.com/openclaw/openclaw) | [`openclaw/onepilot-channel`](./plugins/openclaw/onepilot-channel) | ✅ **Live** | Chat, cron, multi-agent, push alerts |
| [**Hermes Agent**](https://hermes-agent.nousresearch.com/) | [`hermes/*`](./plugins/hermes) | 🚧 Next | Persistent-memory chat, multi-channel gateway mirror |
| [**Paperclip**](https://github.com/paperclipai/paperclip) | [`paperclip/*`](./plugins/paperclip) | 🚧 Next | Agent-company dashboard, budgets, org chart on mobile |

Want another framework? [Open an issue](https://github.com/sofiane8910/onepilotapp/issues/new).

<br>

## Install Onepilot

<table>
<tr>
<td width="60%" valign="top">

The plugin pool is automatic. Pair an agent in the app and the right adapter loads in the background — no tarballs, no terminal commands.

**Free tier:** 1 server, 1 agent, the full terminal ecosystem, file editing, browser, GitHub.
**Pro:** unlimited servers, unlimited agents, file creation, advanced sync.

We never ship behind a paywall — the free tier is the real product.

### [→ Download at onepilotapp.com](https://onepilotapp.com)

</td>
<td width="40%" align="center">
<img src="docs/img/hero.webp" alt="Onepilot home" width="240"/>
</td>
</tr>
</table>

<br>

## Write a plugin

Each plugin lives under `plugins/<framework>/<name>/`. The README inside each folder is the integration guide for that specific framework.

Release flow is git-tag driven:

```sh
# from main, after your plugin is ready to ship
git tag <framework>/<plugin>@v1.2.3
git push origin <framework>/<plugin>@v1.2.3
```

CI picks up the tag, packs the right subdirectory, and uploads the tarball as a GitHub release asset. The app fetches it on demand.

<br>

## Contributing

- **Framework author?** Let's integrate. Open an issue titled `integration: <framework>` and we'll scope a plugin.
- **User?** [Star the repo ⭐](https://github.com/sofiane8910/onepilotapp/stargazers), report bugs, ask for features. Each star bumps the next framework's priority.

<br>

## License

- **Plugin adapters in this repo** (everything under `plugins/`, plus `docs/` and the workflow) — [MIT](./LICENSE). Fork them, ship your own, embed them in whatever runtime you want.
- **The Onepilot iOS app** — closed-source, proprietary. The binary ships through the App Store; its source is not published.

This repo is the **public adapter layer** — it lets any framework wire into Onepilot without touching the app's code. The app itself stays private.

<br>

<div align="center">

### Onepilot — your phone is the remote, your agents do the work.

**[onepilotapp.com](https://onepilotapp.com)**  ·  [Star ⭐](https://github.com/sofiane8910/onepilotapp/stargazers)  ·  [Issues](https://github.com/sofiane8910/onepilotapp/issues)

<sub>Made for developers who do real work from their phone.</sub>

</div>
