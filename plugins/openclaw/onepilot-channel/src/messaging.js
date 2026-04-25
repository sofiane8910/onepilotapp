// Outbound dispatch: take a user message event, run the agent via the
// gateway's OpenAI-compatible endpoint, post the reply back through the
// backend message endpoint.
//
// Why self-fetch to the gateway instead of OpenClaw's native channel dispatch:
//   - zero SDK coupling (no channel registration scaffolding for inbound)
//   - the caller lives inside the gateway process → no external client to
//     disconnect → the LLM call always runs to completion, regardless of
//     mobile-app lifecycle (force-quit survives)
//   - we already have the persistence path wired (backend → push trigger).
//     No new backend code.

import { getAgentId } from "./env.js";

const HISTORY_LIMIT = 20;

/**
 * @param {{
 *   api: any,
 *   accountId: string,
 *   account: {
 *     backendUrl: string,
 *     streamUrl: string,
 *     publishableKey: string,
 *     agentKey: string,
 *     userId: string,
 *     agentProfileId: string,
 *     sessionKey: string,
 *   },
 *   userMessageRow: any,
 *   gatewayPort: number,
 *   gatewayToken: string,
 *   log: (msg: string, err?: unknown) => void,
 * }} params
 */
export async function handleUserMessage(params) {
  const { api, accountId, account, userMessageRow, gatewayPort, gatewayToken, log } = params;
  const sessionId = userMessageRow.session_id;
  if (!sessionId) {
    log(`user row missing session_id, skipping`);
    return;
  }

  // Load history. If an assistant reply newer than this user message already
  // exists in the returned set, a foreground client already answered —
  // skip to avoid double-reply.
  let history;
  try {
    history = await loadHistory(account, sessionId);
  } catch (err) {
    log(`failed to load history`, err);
    return;
  }

  const userCreatedAt = userMessageRow.created_at;
  if (Array.isArray(history)) {
    const hasNewerAssistant = history.some(
      (row) =>
        row?.role === "assistant" &&
        typeof row?.created_at === "string" &&
        typeof userCreatedAt === "string" &&
        row.created_at > userCreatedAt,
    );
    if (hasNewerAssistant) {
      log(`session ${String(sessionId).slice(0, 8)} already has an assistant reply — skipping`);
      return;
    }
  }

  const messages = normalizeHistory(history);

  // Fire the agent via the local gateway.
  //
  // The `x-openclaw-message-channel: onepilot` header tells openclaw's
  // session/runtime layer that this turn belongs to the `onepilot` channel.
  // Without it, openclaw classifies any `/v1/chat/completions` caller as
  // `webchat` (its built-in WebChat UI client name), which is the
  // INTERNAL_MESSAGE_CHANNEL marker. The agent then inherits `webchat`
  // as its `currentChannelId`, and any cron it sets up gets
  // `delivery.channel = "webchat"`. That fails on the next tick because
  // openclaw hard-blocks delivery to WebChat
  // (`infra/outbound/targets.ts:192-198`). Setting the header is enough
  // to flip the agent's channel context to `onepilot` so crons inherit
  // the correct, deliverable channel automatically — no agent-prompt
  // hacks, no SOUL.md edits.
  //
  // `x-openclaw-message-to` carries the routing key our outbound channel
  // uses as `sessionKey` (matching `resolveDefaultTo` in the channel's
  // config adapter). Sending it explicitly avoids a second round-trip
  // through the dispatcher when no `to` is set on the cron job.
  // x-openclaw-session-key gives the agent's runtime a peer-shaped session
  // key (`agent:<agentId>:onepilot:direct:<userId>`) instead of openclaw's
  // default `agent:<agentId>:openai:<uuid>` (built by
  // `gateway/http-utils.ts:78` from the openai-http session prefix).
  //
  // Why the shape matters: the cron tool's `inferDeliveryFromSessionKey`
  // (`openclaw/src/agents/tools/cron-tool.ts:157-208`) parses session keys
  // and auto-fills `delivery: { mode: "announce", channel, to }` whenever
  // it sees the `<channel>:direct:<peerId>` pattern. That's why Telegram
  // users never have to say "send it to my Telegram" — the cron delivery
  // pre-fills from their session key. Without this header our session
  // keys lacked the `:direct:<peerId>` marker and the agent had to invent
  // a delivery shape from scratch (often picking the wrong one).
  //
  // agentId resolution lives in env.js. peerId lowercased for routing.
  // Rationale + scanner gotcha documented in ../CLAUDE.md.
  const agentId = getAgentId();
  const peerId = String(account.userId).trim().toLowerCase();
  const peerSessionKey = `agent:${agentId}:onepilot:direct:${peerId}`;
  let reply;
  try {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${gatewayToken}`,
        "x-openclaw-message-channel": "onepilot",
        "x-openclaw-account-id": accountId,
        "x-openclaw-message-to": userMessageRow.session_key ?? account.sessionKey,
        "x-openclaw-session-key": peerSessionKey,
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

  // Deliver the reply back via the backend message endpoint. Auth is the
  // durable agent key — the endpoint binds (userId, agentProfileId) to the
  // key server-side, so a stolen key cannot post into another user's inbox.
  // UUIDs lowercased to match canonical form (see CLAUDE.md "UUID case").
  try {
    const userIdLc = String(account.userId).toLowerCase();
    const agentProfileIdLc = String(account.agentProfileId).toLowerCase();
    const url = `${account.backendUrl}/functions/v1/agent-message-ingest`;
    const deliverBody = JSON.stringify({
      userId: userIdLc,
      agentProfileId: agentProfileIdLc,
      sessionKey: userMessageRow.session_key ?? account.sessionKey,
      role: "assistant",
      content: [{ type: "text", text: reply }],
      timestamp: Date.now(),
    });
    // Retry on Supabase Edge Runtime transient 5xx (see outbound.js).
    const deliverRes = await postIngestWithRetry(url, account.agentKey, deliverBody, log);
    if (!deliverRes.ok) {
      const body = await deliverRes.text();
      log(`message POST returned ${deliverRes.status}: ${body.slice(0, 200)}`);
      return;
    }
    log(`assistant reply delivered (${reply.length} chars)`);
  } catch (err) {
    log(`message POST failed`, err);
  }
}

async function loadHistory(account, sessionId) {
  // Fetch most recent messages in DESC order. The backend endpoint binds
  // (userId, agentProfileId) to the agentKey — we cannot see anyone else's
  // messages even if the session_id were guessed.
  const url = `${account.backendUrl}/functions/v1/agent-message-history?session_id=${encodeURIComponent(sessionId)}&limit=${HISTORY_LIMIT}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${account.agentKey}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`history load failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return Array.isArray(json?.messages) ? json.messages : [];
}

function normalizeHistory(rows) {
  return rows
    .slice()
    .reverse()
    .map((row) => ({ role: row.role, content: extractText(row.content) }))
    .filter((m) => m.content);
}

function extractText(content) {
  if (content == null) return "";
  if (typeof content === "string") {
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

async function postIngestWithRetry(url, agentKey, body, log) {
  const delays = [250, 750];
  let lastRes;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      lastRes = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${agentKey}`,
        },
        body,
      });
    } catch (err) {
      if (attempt === delays.length) throw err;
      log(`ingest network error (attempt ${attempt + 1}), retrying: ${err?.message ?? err}`);
      await new Promise((r) => setTimeout(r, delays[attempt]));
      continue;
    }
    if (lastRes.status < 500 || attempt === delays.length) return lastRes;
    log(`ingest got ${lastRes.status} (attempt ${attempt + 1}), retrying`);
    await new Promise((r) => setTimeout(r, delays[attempt]));
  }
  return lastRes;
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
