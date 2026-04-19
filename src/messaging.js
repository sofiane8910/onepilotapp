// Outbound dispatch: take a user message row from Supabase, run the agent
// via the gateway's OpenAI-compatible endpoint, write the reply back to
// Supabase via the `openclaw-message-ingest` edge function.
//
// Why self-fetch to the gateway instead of OpenClaw's native channel dispatch:
//   - zero SDK coupling (no channel registration, no `createChatChannelPlugin` scaffolding)
//   - fetch caller lives inside the gateway process → no external client to
//     disconnect → the LLM call always runs to completion, regardless of
//     iOS lifecycle (force-quit survives)
//   - we already have the persistence path wired (openclaw-message-ingest
//     edge function + DB trigger → push-notify). No new code on the Supabase side.

const HISTORY_LIMIT = 20;
const WEBHOOK_AUTH_KEY = "onepilot-openclaw-sync-v1"; // mirrors OpenClawAdapter.webhookAuthKey

/**
 * @param {{
 *   api: any,
 *   accountId: string,
 *   account: {
 *     supabaseUrl: string,
 *     supabaseAnonKey: string,
 *     userId: string,
 *     agentProfileId: string,
 *     sessionKey: string,
 *   },
 *   getAccessToken: () => Promise<string>,
 *   userMessageRow: any,
 *   gatewayPort: number,
 *   gatewayToken: string,
 *   log: (msg: string, err?: unknown) => void,
 * }} params
 */
export async function handleUserMessage(params) {
  const { api, accountId, account, getAccessToken, userMessageRow, gatewayPort, gatewayToken, log } = params;
  const sessionId = userMessageRow.session_id;
  if (!sessionId) {
    log(`user row missing session_id, skipping`);
    return;
  }

  // Skip if an assistant reply already exists for this user message
  // (foreground race: iOS SSE may have landed faster).
  try {
    const jwt = await getAccessToken();
    const checkUrl = `${account.supabaseUrl}/rest/v1/messages?select=id&session_id=eq.${sessionId}&role=eq.assistant&created_at=gt.${encodeURIComponent(userMessageRow.created_at)}&limit=1`;
    const checkRes = await fetch(checkUrl, {
      headers: { apikey: account.supabaseAnonKey, Authorization: `Bearer ${jwt}` },
    });
    if (checkRes.ok) {
      const rows = await checkRes.json();
      if (Array.isArray(rows) && rows.length > 0) {
        log(`session ${String(sessionId).slice(0, 8)} already has an assistant reply — skipping`);
        return;
      }
    }
  } catch (err) {
    log(`already-answered probe failed (continuing): ${String(err)}`);
  }

  // Build message history from Supabase.
  let messages;
  try {
    messages = await loadHistory(account, sessionId, await getAccessToken());
  } catch (err) {
    log(`failed to load history`, err);
    return;
  }

  // Fire the agent via the local gateway. `stream: false` gets us a single JSON.
  let reply;
  try {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${gatewayToken}`,
      },
      body: JSON.stringify({
        model: "openclaw", // gateway ignores; uses its configured default
        messages,
        stream: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      log(`gateway /v1/chat/completions returned ${res.status}: ${body.slice(0, 200)}`);
      return;
    }
    const completion = await res.json();
    reply = extractAssistantText(completion);
  } catch (err) {
    log(`gateway call failed`, err);
    return;
  }

  if (!reply) {
    log(`gateway returned no assistant text`);
    return;
  }

  // Deliver the reply back to Supabase via the existing ingest edge function.
  try {
    const ingestUrl = `${account.supabaseUrl}/functions/v1/openclaw-message-ingest`;
    const deliverRes = await fetch(ingestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${WEBHOOK_AUTH_KEY}`,
      },
      body: JSON.stringify({
        userId: account.userId,
        agentProfileId: account.agentProfileId,
        sessionKey: userMessageRow.session_key ?? account.sessionKey,
        role: "assistant",
        content: [{ type: "text", text: reply }],
        timestamp: Date.now(),
      }),
    });
    if (!deliverRes.ok) {
      const body = await deliverRes.text();
      log(`ingest POST returned ${deliverRes.status}: ${body.slice(0, 200)}`);
      return;
    }
    log(`assistant reply delivered (${reply.length} chars)`);
  } catch (err) {
    log(`ingest POST failed`, err);
  }
}

async function loadHistory(account, sessionId, jwt) {
  const url = `${account.supabaseUrl}/rest/v1/messages?select=role,content&session_id=eq.${sessionId}&order=created_at.asc&limit=${HISTORY_LIMIT}`;
  const res = await fetch(url, {
    headers: { apikey: account.supabaseAnonKey, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`history load failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const rows = await res.json();
  return rows
    .map((row) => ({ role: row.role, content: extractText(row.content) }))
    .filter((m) => m.content);
}

function extractText(content) {
  // Supabase stores content as jsonb; can be string, nested JSON string, or array.
  if (content == null) return "";
  if (typeof content === "string") {
    // Maybe JSON-encoded
    try {
      return extractText(JSON.parse(content));
    } catch {
      return content;
    }
  }
  if (Array.isArray(content)) {
    const textPart = content.find(
      (p) => p && typeof p === "object" && (p.type === "text" || !p.type) && typeof p.text === "string",
    );
    return textPart?.text ?? "";
  }
  if (typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}

function extractAssistantText(completion) {
  if (!completion) return "";
  const choice = completion.choices?.[0];
  if (!choice) return "";
  const msg = choice.message;
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    const textPart = msg.content.find(
      (p) => p && typeof p === "object" && (p.type === "text" || !p.type) && typeof p.text === "string",
    );
    return textPart?.text ?? "";
  }
  return "";
}
