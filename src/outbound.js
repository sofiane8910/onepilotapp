// Outbound channel handler for the `onepilot` channel.
//
// OpenClaw's cron (and any other agent action that does outbound delivery)
// resolves `delivery.channel` against the registered channel registry and
// dispatches the message to that channel's `sendText`. Without a registered
// `onepilot` channel, cron jobs fail at fire-time with "channel is required".
//
// We reuse the same delivery pipe the assistant-reply path uses
// (messaging.js): POST to the openclaw-message-ingest edge function, which
// writes the message into Supabase and triggers push-notify → APNs.

import { WEBHOOK_AUTH_KEY } from "./constants.js";

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
 *   log: (msg: string, err?: unknown) => void,
 * }} params
 */
export async function sendOnepilotText({ ctx, accounts, log }) {
  const accountId = ctx.accountId ?? Object.keys(accounts)[0] ?? "default";
  const account = accounts[accountId];
  if (!account) {
    throw new Error(`onepilot: no account "${accountId}" configured`);
  }

  // ctx.to optionally overrides sessionKey (the cron --to flag). When the
  // agent omits it, we deliver into the account's default session ("main").
  const sessionKey =
    typeof ctx.to === "string" && ctx.to.length > 0 ? ctx.to : account.sessionKey;

  const ingestUrl = `${account.supabaseUrl}/functions/v1/openclaw-message-ingest`;
  const res = await fetch(ingestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WEBHOOK_AUTH_KEY}`,
    },
    body: JSON.stringify({
      userId: account.userId,
      agentProfileId: account.agentProfileId,
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
