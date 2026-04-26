<div align="center">

<img src="docs/img/onepilot-banner.png" alt="Onepilot — your servers, in your pocket. iOS app for SSH and AI agent ops." width="900"/>

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
flowchart TB
    P(["📱 &nbsp;&nbsp;ONEPILOT iOS&nbsp;&nbsp;"])

    P ==> T["&nbsp;⌨️ &nbsp;&nbsp;PILLAR 1 &nbsp;&nbsp;·&nbsp;&nbsp; Modern mobile terminal&nbsp;"]
    P ==> A["&nbsp;✦ &nbsp;&nbsp;PILLAR 2 &nbsp;&nbsp;·&nbsp;&nbsp; AI agent ops&nbsp;"]

    T --> T1["Real SSH &nbsp;·&nbsp; mosh &nbsp;·&nbsp; port forward"]
    T1 --> T2["Live file edit on the remote box"]
    T2 --> T3["localhost:3000 preview in-app browser"]
    T3 --> T4["GitHub PRs &nbsp;·&nbsp; repos &nbsp;·&nbsp; Actions"]
    T4 --> T5["Cron monitor &nbsp;·&nbsp; directory picker"]

    A --> A1["Deploy an agent in &lt; 60 seconds"]
    A1 --> A2["Chat with your agents from your phone"]
    A2 --> A3["Cron jobs &nbsp;·&nbsp; run-now &nbsp;·&nbsp; tail logs"]
    A3 --> A4["Push notification when work finishes"]
    A4 --> A5["Bring your own LLM key &nbsp;·&nbsp; Claude, GPT, OSS"]

    linkStyle 0,1 stroke:#0a0a0a,stroke-width:2px
    linkStyle 2,3,4,5,6 stroke:#0cce6b,stroke-width:1.5px
    linkStyle 7,8,9,10,11 stroke:#0070f3,stroke-width:1.5px

    classDef root fill:#0a0a0a,stroke:#0a0a0a,color:#fff,font-weight:bold
    classDef pillar1 fill:#f0fdf4,stroke:#0cce6b,color:#0a0a0a,font-weight:bold
    classDef pillar2 fill:#eff6ff,stroke:#0070f3,color:#0a0a0a,font-weight:bold
    classDef leaf1 fill:#ffffff,stroke:#bbf7d0,color:#0a0a0a
    classDef leaf2 fill:#ffffff,stroke:#bfdbfe,color:#0a0a0a
    class P root
    class T pillar1
    class A pillar2
    class T1,T2,T3,T4,T5 leaf1
    class A1,A2,A3,A4,A5 leaf2
```

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

## Why this exists

Mobile SSH apps have been frozen in 2014. They give you a prompt and call it done. But modern development isn't just typing into a shell — it's editing files, previewing localhost, reviewing PRs, watching crons, talking to agents. Onepilot is what happens when you build the **whole loop** for the phone instead of just the terminal pane.

The agent layer comes from the same observation: running an AI agent on your server today means SSH'ing in to edit YAML, then setting up a Telegram bot to talk to it. Onepilot collapses that to a guided wizard and an in-app chat.

<br>

## The repo: framework adapter pool

```mermaid
flowchart TB
    A(["📱 &nbsp;ONEPILOT iOS&nbsp;"])
    A -- "pair a server &nbsp;·&nbsp; pick a framework" --> B["📦 &nbsp;PUBLIC PLUGIN POOL &nbsp;·&nbsp; this repo &nbsp;·&nbsp; MIT&nbsp;<br/><sub>plugins/&lt;framework&gt;/</sub>"]
    B ==> C["<b>🦀 &nbsp;OpenClaw</b><br/><b>● &nbsp;LIVE</b><br/>━━━━━━━━━━━━━━━<br/>chat<br/>cron<br/>multi-agent<br/>push alerts"]
    B -.-> D["<b>⚔️ &nbsp;Hermes</b><br/>○ &nbsp;NEXT<br/>━━━━━━━━━━━━━━━<br/>persistent-memory chat<br/>gateway mirror"]
    B -.-> E["<b>🧷 &nbsp;Paperclip</b><br/>○ &nbsp;NEXT<br/>━━━━━━━━━━━━━━━<br/>agent-company dashboard<br/>budgets &nbsp;·&nbsp; org chart"]

    classDef root fill:#0070f3,stroke:#0058c4,color:#fff,font-weight:bold
    classDef pool fill:#eff6ff,stroke:#0070f3,color:#0a0a0a,font-weight:bold
    classDef openclaw fill:#fff7ed,stroke:#fb923c,color:#0a0a0a,font-weight:bold
    classDef hermes fill:#f0fdf4,stroke:#14532d,color:#0a0a0a
    classDef paperclip fill:#fafafa,stroke:#d4d4d4,color:#666
    class A root
    class B pool
    class C openclaw
    class D hermes
    class E paperclip
```

This repo is the **public plugin pool** that powers Onepilot's agent pillar. Every framework we integrate with ships its adapter here. When you pair a server in the app, the right adapter is fetched automatically.

> **Drop-in integration.** If you run an agent framework, you get a free iOS front-end. No SDK to learn, no UI to build.

<br>

## Supported frameworks

| Framework | Plugin | Status | What it adds to Onepilot |
|---|---|---|---|
| <img src="docs/img/openclaw-logo.png" width="28" align="left"/> &nbsp;[**OpenClaw**](https://github.com/openclaw/openclaw) | [`openclaw/onepilot-channel`](./plugins/openclaw/onepilot-channel) | ✅ **Live** | Chat, cron, multi-agent, push alerts |
| <img src="docs/img/hermes-logo.png" width="28" align="left"/> &nbsp;[**Hermes Agent**](https://hermes-agent.nousresearch.com/) | [`hermes/*`](./plugins/hermes) | 🚧 Next | Persistent-memory chat, multi-channel gateway mirror |
| <img src="docs/img/paperclip-logo.png" width="28" align="left"/> &nbsp;[**Paperclip**](https://github.com/paperclipai/paperclip) | [`paperclip/*`](./plugins/paperclip) | 🚧 Next | Agent-company dashboard, budgets, org chart on mobile |

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
