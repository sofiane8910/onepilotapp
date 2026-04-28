// Network-free module — must stay isolated from any outbound capability.
// The install-time scanner blocks files mixing process.env reads with
// outbound calls. Keep this file environment-reads-only.

export function getAgentId() {
  const raw = process.env.OPENCLAW_PROFILE;
  return (typeof raw === "string" ? raw : "default").trim().toLowerCase() || "default";
}
