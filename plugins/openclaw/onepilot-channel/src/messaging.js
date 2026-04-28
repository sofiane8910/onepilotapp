// Run a user message through the gateway, deliver the reply via the backend.

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

  let history;
  try {
    history = await loadHistory(account, sessionId);
  } catch (err) {
    log(`failed to load history`, err);
    return;
  }

  // Skip if a foreground client (open Onepilot app) already replied.
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

  // The x-openclaw-* headers route this turn through the `onepilot` channel
  // so any cron the agent sets up inherits the right delivery channel
  // (vs the default `webchat` which the gateway hard-blocks for delivery).
  // peerSessionKey shape (`<channel>:direct:<peerId>`) lets the cron tool
  // auto-fill `delivery: { mode: "announce", channel, to }`.
  const agentId = getAgentId();
  const peerId = String(account.userId).trim().toLowerCase();
  const peerSessionKey = `agent:${agentId}:onepilot:direct:${peerId}`;
  // stream:true keeps the connection alive across long thinks even though
  // we accumulate the whole reply locally and POST once at end-of-stream.
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
        "Accept": "text/event-stream",
      },
      body: JSON.stringify({
        model: "openclaw",
        messages,
        stream: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      log(`gateway /v1/chat/completions returned ${res.status}: ${body.slice(0, 200)}`);
      return;
    }
    reply = await readSseAssistantText(res, log);
  } catch (err) {
    log(`gateway call failed`, err);
    return;
  }

  if (!reply) {
    log(`gateway returned no assistant text`);
    return;
  }

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
    const deliverRes = await postIngestWithRetry(url, account.agentKey, deliverBody, log);
    if (!deliverRes.ok) {
      const body = await deliverRes.text();
      log(`message POST returned ${deliverRes.status} after retries: ${body.slice(0, 200)} — sending user-visible fallback`);
      await sendDeliveryFailureNotice({
        url,
        agentKey: account.agentKey,
        userIdLc,
        agentProfileIdLc,
        sessionKey: userMessageRow.session_key ?? account.sessionKey,
        log,
      });
      return;
    }
    log(`assistant reply delivered (${reply.length} chars)`);
  } catch (err) {
    log(`message POST failed`, err);
    try {
      const userIdLc = String(account.userId).toLowerCase();
      const agentProfileIdLc = String(account.agentProfileId).toLowerCase();
      const url = `${account.backendUrl}/functions/v1/agent-message-ingest`;
      await sendDeliveryFailureNotice({
        url,
        agentKey: account.agentKey,
        userIdLc,
        agentProfileIdLc,
        sessionKey: userMessageRow.session_key ?? account.sessionKey,
        log,
      });
    } catch (notifyErr) {
      log(`fallback notice also failed`, notifyErr);
    }
  }
}

async function sendDeliveryFailureNotice({ url, agentKey, userIdLc, agentProfileIdLc, sessionKey, log }) {
  const noticeBody = JSON.stringify({
    userId: userIdLc,
    agentProfileId: agentProfileIdLc,
    sessionKey,
    role: "assistant",
    content: [{
      type: "text",
      text: "⚠ I generated a reply but couldn't reach the server to deliver it. Please send your message again.",
    }],
    timestamp: Date.now(),
  });
  const delays = [500, 1500];
  let lastRes;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      lastRes = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${agentKey}`,
        },
        body: noticeBody,
      });
    } catch (err) {
      if (attempt === delays.length) {
        log(`fallback notice network error, giving up: ${err?.message ?? err}`);
        return;
      }
      await new Promise((r) => setTimeout(r, delays[attempt]));
      continue;
    }
    if (lastRes.ok) {
      log(`fallback notice delivered to user`);
      return;
    }
    if (lastRes.status < 500 || attempt === delays.length) {
      log(`fallback notice failed: ${lastRes.status} (final)`);
      return;
    }
    await new Promise((r) => setTimeout(r, delays[attempt]));
  }
}

async function loadHistory(account, sessionId) {
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

async function readSseAssistantText(res, log) {
  const decoder = new TextDecoder();
  let buf = "";
  let acc = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const delta = j?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") acc += delta;
      } catch (err) {
        log(`sse parse error (skipping line): ${err?.message ?? err}`);
      }
    }
  }
  return acc;
}

async function postIngestWithRetry(url, agentKey, body, log) {
  // ~60s budget across 8 attempts to ride out worker recycles + brief drops.
  const delays = [500, 1000, 2000, 4000, 8000, 15000, 30000];
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
