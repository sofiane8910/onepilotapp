# onepilotapp

OpenClaw channel plugin for the Onepilot iOS app.

Bridges Onepilot iOS messages to the agent runtime via Supabase Realtime. Runs inside the OpenClaw gateway process on the user's own server (Docker / VPS / Mac Mini).

## How it's used

This plugin is not intended to be installed manually. The Onepilot iOS app deploys it automatically when you set up an agent. It fetches the latest release tarball from this repo, verifies its sha256 against the value stored in the Onepilot backend, and registers it with the local `openclaw` CLI.

## Releases

Tagged versions (`vX.Y.Z`) publish a release with the plugin tarball attached. The sha256 of each tarball is in the release notes. The Onepilot backend points the app at the current stable release via a `plugin_manifest` row.

To cut a release: `git tag vX.Y.Z && git push --tags`. GitHub Actions builds the tarball and creates the release.

## License

MIT.
