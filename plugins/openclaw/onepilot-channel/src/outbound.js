// Outbound channel handler for the `onepilot` channel.

/**
 * @param {{
 *   ctx: { to?: string, text: string, accountId?: string | null },
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

  const sessionKey = account.sessionKey;

  // Lowercase UUIDs at the boundary — backend stores canonical lowercase.
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
  const delays = [500, 1000, 2000, 4000, 8000, 15000, 30000];
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
