# Security model — `onepilot-skills`

## What this plugin defends against

| Concern | Mitigation |
|---|---|
| Backend / Supabase access from the plugin | The plugin imports zero networking modules (`requests`, `httpx`, `urllib`, `socket`). Even if compromised it cannot reach `*.supabase.co` or any other Onepilot-controlled endpoint. The CI security-check linter blocks reintroduction. |
| Secret / credential exfiltration | `os.environ` is read **only** for `HERMES_HOME`. No reading of `~/.env`, `.netrc`, `~/.aws/credentials`, etc. No file writes — an attacker cannot stage a payload to exfiltrate later. |
| Command injection from the iOS caller | Entry point uses `argparse` with `choices=[...]` for `--mode` and a strict regex (`^[A-Za-z0-9_./\-]{1,200}$`) for `--name`. `--page`, `--page-size`, `--source` get integer / length clamps. No `subprocess.run`, `os.system`, `shell=True` anywhere. |
| Path traversal via `--name` | Regex above forbids leading `/` and `..` segments. We never concatenate `--name` into a filesystem path ourselves — Hermes' `inspect_skill` does its own resolution — but we add the input-shape check as defense in depth. |
| Plugin tampering on the host | `hermes plugins install` runs Hermes' built-in `tools.skills_guard.scan_skill` against every plugin before copying it into `~/.hermes/plugins/`. Our plugin is built to pass that scan trivially: read-only filesystem, no risky imports, no subprocess. |
| Supply-chain attack on the GitHub source | TLS to github.com plus Hermes' install-time content scan. We sign release tags. **Trust assumption**: GitHub's TLS chain + GitHub repo branch protection. Same boundary Hermes itself relies on for `hermes plugins install`. |
| Output injection back into iOS | Output is `json.dump`-emitted (RFC-compliant escaping). SwiftUI `Text` views render output as plain text — no markdown / HTML interpretation. No JS context anywhere on the iOS side. |
| Logging leaks | No `logging`. Exception envelopes contain only the exception **class name**, never the message — exception messages can carry filesystem paths or Hermes-internal state we don't want trickling out over SSH transcripts. |

## What this plugin does NOT defend against

| Out of scope | Why |
|---|---|
| User pushing malicious code to the Onepilot GitHub org | Repo access control is the boundary. We use signed tags and branch protection. Beyond our reach from inside the plugin. |
| A compromised Hermes install on the user's host | If `~/.hermes/` is already compromised, the attacker has all the access the plugin would. We're not the trust boundary. |
| The user explicitly running our scripts with elevated privileges | Plugin runs as the user. `sudo python3 …` would obviously elevate; not our problem. |
| MITM on the user's SSH session | SSH session encryption is the boundary, not us. |

## Hard invariants

These are **enforced by code review and CI** (`ci/plugin/onepilot-skills/security-check.sh`).
A single hit fails the build:

- 🚫 `import requests`
- 🚫 `import httpx`
- 🚫 `import urllib`
- 🚫 `import socket`
- 🚫 `import subprocess`
- 🚫 `os.system`
- 🚫 `shell=True`
- 🚫 `eval(`, `exec(`, `compile(`
- 🚫 `open(..., "w"|"a"|"x")` — file writes
- 🚫 `os.environ[` — bracket access (we only allow `os.environ.get("HERMES_HOME")`)
- 🚫 `Popen`
- ✅ Every script entry calls `argparse` with `choices=[...]` for `--mode`
- ✅ Every Hermes import is in a `try/except ImportError`
- ✅ Every catch block emits a sanitized envelope (`type(e).__name__`),
       never `str(e)` or the traceback

## Scope of changes that require security re-review

If you intend to add any of these, the change needs an explicit security
re-review (and probably a redesign):

- Any networking import or HTTP call.
- Any filesystem write outside the plugin install dir.
- Any subprocess execution.
- Any `os.environ` access beyond `HERMES_HOME`.
- Any change that makes input validation weaker (loosening the `--name`
  regex, expanding `--mode` choices to dynamic values).
- Any change that emits `str(e)` or tracebacks to stdout.

## Reporting

Found a security issue? Email security@onepilotapp.com. Please don't open
public GitHub issues for vulnerabilities.
