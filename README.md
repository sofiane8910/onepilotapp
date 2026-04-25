<div align="center">

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

## What Onepilot is

```mermaid
flowchart LR
    P([📱 Onepilot])
    subgraph T1[" "]
      direction TB
      L1["⌨ Terminal"]
      L2["📝 Live file edit"]
      L3["🌐 localhost preview"]
      L4["🐙 GitHub PRs"]
    end
    subgraph T2[" "]
      direction TB
      R1["⚡ Deploy agents"]
      R2["💬 Chat from your phone"]
      R3["⏱ Cron jobs"]
      R4["🔔 Push when done"]
    end
    T1 --- P --- T2
    classDef root fill:#0070f3,stroke:#0058c4,color:#fff,font-weight:bold
    classDef left fill:#f0fdf4,stroke:#0cce6b,color:#0a0a0a
    classDef right fill:#eff6ff,stroke:#0070f3,color:#0a0a0a
    class P root
    class L1,L2,L3,L4 left
    class R1,R2,R3,R4 right
    style T1 fill:none,stroke:none
    style T2 fill:none,stroke:none
```

**Pillar 1** — modern mobile terminal + dev ecosystem. **Pillar 2** — AI agent ops on your phone.

<br>

## How agents work

```mermaid
flowchart LR
    A["📱 Onepilot"] -- "chat / cron" --> B[("🔄 Realtime sync")]
    B -- "encrypted" --> C["🖥 Your server"]
    C --> D["🤖 OpenClaw runtime"]
    D -- "results" --> B
    B -- "🔔 push" --> A
```

Spin up an agent on your own server with a guided wizard. No YAML to edit, no Telegram bot to babysit. Talk to it directly from the app.

<br>

## See it

<table>
  <tr>
    <td width="33%" align="center">
      <a href="https://onepilotapp.com"><img src="docs/img/hero.webp" alt="Home dashboard" width="100%"/></a>
      <br><sub><b>Home</b> · servers + agents at a glance</sub>
    </td>
    <td width="33%" align="center">
      <a href="https://onepilotapp.com"><img src="docs/img/terminal.webp" alt="Live SSH terminal" width="100%"/></a>
      <br><sub><b>Terminal</b> · real SSH, real PTY</sub>
    </td>
    <td width="33%" align="center">
      <a href="https://onepilotapp.com"><img src="docs/img/agents.webp" alt="Agent chat" width="100%"/></a>
      <br><sub><b>Agents</b> · chat with your fleet</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://onepilotapp.com"><img src="docs/img/servers.webp" alt="Servers list" width="100%"/></a>
      <br><sub><b>Servers</b> · pair, monitor, jump</sub>
    </td>
    <td align="center">
      <a href="https://onepilotapp.com"><img src="docs/img/deploy.webp" alt="Agent deploy wizard" width="100%"/></a>
      <br><sub><b>Deploy</b> · agent in &lt; 60s</sub>
    </td>
    <td align="center">
      <a href="https://onepilotapp.com"><img src="docs/img/control.webp" alt="Cron + control panel" width="100%"/></a>
      <br><sub><b>Control</b> · cron, run-now, logs</sub>
    </td>
  </tr>
</table>

<br>

## Why this exists

Mobile SSH apps have been frozen in 2014. They give you a prompt and call it done. But modern development isn't just typing into a shell — it's editing files, previewing localhost, reviewing PRs, watching crons, talking to agents. Onepilot is what happens when you build the **whole loop** for the phone instead of just the terminal pane.

The agent layer comes from the same observation: running an AI agent on your server today means SSH'ing in to edit YAML, then setting up a Telegram bot to talk to it. Onepilot collapses that to a guided wizard and an in-app chat.

<br>

## The repo: framework adapter pool

```mermaid
flowchart LR
    A["📱 Onepilot app"] -- pair server --> B["📦 plugins/&lt;framework&gt;/"]
    B --> C["🤖 OpenClaw"]
    B -.-> D["🧠 Hermes (next)"]
    B -.-> E["🧷 Paperclip (next)"]
```

This repo is the **public plugin pool** that powers Onepilot's agent pillar. Every framework we integrate with ships its adapter here. When you pair a server in the app, the right adapter is fetched automatically.

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

The plugin pool is automatic. Pair an agent in the app and the right adapter loads in the background — no tarballs, no terminal commands.

### [→ Download at onepilotapp.com](https://onepilotapp.com)

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

<br>

<div align="center">

### Onepilot — your phone is the remote, your agents do the work.

**[onepilotapp.com](https://onepilotapp.com)**  ·  [Star ⭐](https://github.com/sofiane8910/onepilotapp/stargazers)  ·  [Issues](https://github.com/sofiane8910/onepilotapp/issues)

<sub>Made for developers who do real work from their phone.</sub>

</div>
