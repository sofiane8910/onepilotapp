// Outbound channel handler for the `onepilot` channel.
//
// OpenClaw's cron (and any other agent action that does outbound delivery)
// resolves `delivery.channel` against the registered channel registry and
// dispatches the message to that channel's `sendText`. Without a registered
// `onepilot` channel, cron jobs fail at fire-time with "channel is required".
//
// We reuse the same delivery pipe the assistant-reply path uses
// (messaging.js): POST to the ingest endpoint, which persists the message
// and triggers the push notification.

/**
 * @param {{
 *   ctx: {
 *     to?: string,
 *     text: string,
 *     accountId?: string | null,
 *   },
 *   accounts: Record<string, {
 *     supabaseUrl: string,
 *     supabaseAnonKey: string,
 *     userId: string,
 *     agentProfileId: string,
 *     sessionKey: string,
 *   }>,
 *   getAccessToken: (accountId: string) => Promise<string>,
 *   log: (msg: string, err?: unknown) => void,
 * }} params
 */
export async function sendOnepilotText({ ctx, accounts, getAccessToken, log }) {
  const accountId = ctx.accountId ?? Object.keys(accounts)[0] ?? "default";
  const account = accounts[accountId];
  if (!account) {
    throw new Error(`onepilot: no account "${accountId}" configured`);
  }

  // Onepilot is one-agent-one-thread: every outbound message lands in the
  // account's single session (usually "main"), regardless of any `ctx.to`
  // the cron tool auto-inferred from the agent's peer session key. The
  // cron tool's inferDeliveryFromSessionKey fills `delivery.to` with the
  // recipient's userId (from the `:direct:<userId>` suffix), which used
  // to get written here as session_key — creating a ghost session keyed
  // on the userId that never surfaced in the chat list.
  const sessionKey = account.sessionKey;

  // Auth: user's own access token. The ingest endpoint verifies the token
  // belongs to the userId we claim in the body — so a stolen token from
  // one user can't inject messages into another user's inbox.
  const jwt = await getAccessToken(accountId);

  // Normalize UUIDs to lowercase before sending. Swift emits uppercase
  // UUIDs by default; the backend stores the canonical lowercase form.
  // See CLAUDE.md "UUID case" section — we've been burned by this more
  // than once.
  const userIdLc = String(account.userId).toLowerCase();
  const agentProfileIdLc = String(account.agentProfileId).toLowerCase();

  const ingestUrl = `${account.supabaseUrl}/functions/v1/openclaw-message-ingest`;
  const res = await fetch(ingestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      userId: userIdLc,
      agentProfileId: agentProfileIdLc,
      sessionKey,
      role: "assistant",
      content: [{ type: "text", text: ctx.text }],
      timestamp: Date.now(),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`onepilot ingest POST ${res.status}: ${body.slice(0, 200)}`);
  }

  const messageId = `onepilot-${Date.now()}`;
  log(`outbound delivered (${ctx.text.length} chars, session=${sessionKey})`);
  return { channel: "onepilot", messageId };
}
