// Shared shared-secret used by both the outbound delivery path (outbound.js)
// and the assistant-reply path (messaging.js) when POSTing to the
// openclaw-message-ingest edge function. Mirrors OpenClawAdapter.webhookAuthKey
// on the iOS side.
export const WEBHOOK_AUTH_KEY = "onepilot-openclaw-sync-v1";
