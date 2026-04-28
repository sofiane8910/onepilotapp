# onepilot-skills (Hermes plugin)

Read-only skill discovery surface for the [Onepilot](https://onepilotapp.com)
iOS app. Sits on top of Hermes' built-in `hermes_cli.skills_hub` helpers
(`browse_skills`, `inspect_skill`) and `agent.skill_commands.scan_skill_commands`,
combining them with a filesystem walk + `~/.hermes/config.yaml` +
`~/.hermes/skills/.hub/lock.json` to give the iOS app a single,
version-stamped JSON envelope per request.

## Why a separate plugin?

The Onepilot ecosystem already ships a `onepilot` Hermes plugin that
handles chat I/O and cron-delivery — runtime-critical surfaces. This
plugin is intentionally separate so:

- **Independent versioning** — a skill-fetch shape change ships without
  redeploying the chat plugin (and vice versa).
- **Smaller blast radius** — a bug here can leave the marketplace empty;
  it cannot touch the chat channel.
- **Faster iteration** — Hermes upstream API drift in `skills_hub`
  affects only this plugin; a one-line patch + plugin reinstall is
  enough, no iOS App Store cycle.

## Install

```sh
hermes plugins install https://github.com/onepilotapp/onepilot-skills
```

Lives at `~/.hermes/plugins/onepilot-skills/` after install. The Onepilot
iOS app probes for the script and offers a one-tap install when it isn't
present.

## Usage

```
python3 ~/.hermes/plugins/onepilot-skills/skills_dump.py --mode <mode> [args]
```

Modes:

| Mode | Args | Returns |
|---|---|---|
| `installed` | _(none)_ | `{plugin_version, skills:[…], count}` |
| `hub` | `[--page N] [--page-size N] [--source S]` | `{plugin_version, items, page, total_pages, total}` |
| `inspect` | `--name <skill>` | `{plugin_version, skill: {…} \| null}` |

Every envelope carries `plugin_version` so the consumer can detect drift.
Errors are returned as `{plugin_version, error: "<exception-class>"}` —
never as tracebacks. See `SECURITY.md` for the full threat model.

## Security

This plugin runs entirely offline. It performs zero network calls of its
own (Hermes' helpers may; that's their boundary, not ours). It writes
zero files. It reads only `~/.hermes/{skills,profiles,config.yaml}` and
the `HERMES_HOME` env var. It executes no subprocesses.

`ci/plugin/onepilot-skills/security-check.sh` (in the Onepilot repo)
greps the source tree on every CI run and fails on any of:
`import requests/httpx/urllib/socket/subprocess`, `os.system`,
`shell=True`, or any non-`HERMES_HOME` `os.environ[...]` access. See
`SECURITY.md` for the full invariant list.

## Development

```
cd onepilotapp/plugins/hermes/onepilot-skills
pytest tests/
```

## License

MIT.
