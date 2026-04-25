// Outbound channel handler for the `onepilot` channel.
//
// OpenClaw's cron (and any other agent action that does outbound delivery)
// resolves `delivery.channel` against the registered channel registry and
// dispatches the message to that channel's `sendText`. Without a registered
// `onepilot` channel, cron jobs fail at fire-time with "channel is required".
//
// We reuse the same delivery pipe the assistant-reply path uses
// (messaging.js): POST to the backend message endpoint, which persists the
// message and triggers the push notification.

/**
 * @param {{
 *   ctx: {
 *     to?: string,
 *     text: string,
 *     accountId?: string | null,
 *   },
 *   accounts: Record<string, {
 *     backendUrl: string,
 *     agentKey: string,
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

  // Onepilot is one-agent-one-thread: every outbound message lands in the
  // account's single session (usually "main"), regardless of any `ctx.to`
  // the cron tool auto-inferred from the agent's peer session key.
  const sessionKey = account.sessionKey;

  // Normalize UUIDs to lowercase before sending. Swift emits uppercase
  // UUIDs by default; the backend stores the canonical lowercase form.
  // See CLAUDE.md "UUID case" section — we've been burned by this more
  // than once.
  const userIdLc = String(account.userId).toLowerCase();
  const agentProfileIdLc = String(account.agentProfileId).toLowerCase();

  const url = `${account.backendUrl}/functions/v1/agent-message-ingest`;
  const body = JSON.stringify({
    userId: userIdLc,
    agentProfileId: agentProfileIdLc,
    sessionKey,
    role: "assistant",
    content: [{ type: "text", text: ctx.text }],
    timestamp: Date.now(),
  });

  // Retry on Supabase Edge Runtime transient 5xx (mostly 503 with null
  // function_id — runtime worker boot/recycle, not our function failing).
  // 3 attempts, 250/750ms backoff.
  const res = await postWithRetry(url, account.agentKey, body, log);

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`onepilot message POST ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const messageId = `onepilot-${Date.now()}`;
  log(`outbound delivered (${ctx.text.length} chars, session=${sessionKey})`);
  return { channel: "onepilot", messageId };
}

async function postWithRetry(url, agentKey, body, log) {
  const delays = [250, 750];
  let lastRes;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      lastRes = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${agentKey}`,
        },
        body,
      });
    } catch (err) {
      if (attempt === delays.length) throw err;
      log(`ingest network error (attempt ${attempt + 1}), retrying: ${err?.message ?? err}`);
      await sleep(delays[attempt]);
      continue;
    }
    if (lastRes.status < 500 || attempt === delays.length) return lastRes;
    log(`ingest got ${lastRes.status} (attempt ${attempt + 1}), retrying`);
    await sleep(delays[attempt]);
  }
  return lastRes;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
