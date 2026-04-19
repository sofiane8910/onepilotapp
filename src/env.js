// Tiny module that reads the runtime environment (OpenClaw profile name).
// Kept on its own so the install-time scanner can confirm this code does
// nothing other than read one well-known variable. Do NOT add any I/O
// or networking helpers here, and do not name those concepts in
// comments either — the scanner regex matches keywords inside comments
// too and will block the install.
//
// See ../CLAUDE.md ("OpenClaw plugin install-time security scanner")
// for the underlying rule and why it lives in its own module.

/**
 * The openclaw profile name (= agent id) the gateway was started with.
 * Set by `openclaw --profile <id> gateway run`. Falls back to "default"
 * when no profile is set so callers can still build a usable session key.
 */
export function getAgentId() {
  const raw = process.env.OPENCLAW_PROFILE;
  return (typeof raw === "string" ? raw : "default").trim().toLowerCase() || "default";
}
