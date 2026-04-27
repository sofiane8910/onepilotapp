"""Onepilot channel plugin for Hermes.

Loaded by Hermes' PluginManager (hermes_cli/plugins.py) at gateway startup.
The plugin spawns one long-running asyncio task that:

1. Subscribes to the inbound channel, filtered to this user's messages.
2. On a row with role="user", invokes Hermes' OpenAI-compatible API server
   (running in the same process at http://127.0.0.1:<API_SERVER_PORT>/v1/chat/completions)
   to produce an assistant reply.
3. Posts the reply to the backend message endpoint, which inserts it and
   delivers a push notification to the user's devices.

It also installs a synchronous cron-delivery channel by patching
`cron.scheduler` so jobs created with `--deliver onepilot[:<sessionKey>]`
route their output to the same backend ingest endpoint. Hermes has no
public channel-registry API (PluginContext only exposes tools, hooks,
CLI commands), and the cron scheduler hardcodes its known platforms in
a frozenset; we extend that set and wrap `_deliver_result` at register
time so cron output flows through the same ingest path as live chat.

Auth: a durable per-agent API key (server-bound to one user+agent pair),
exchanged on demand for short-lived stream JWTs. Config lives next to this
file as `config.json`, written by the Onepilot deploy step.

The plugin assumes Hermes' API server is enabled (config.yaml:
`platforms.api_server.enabled: true`). The deploy step flips that flag.

Wire protocol: Phoenix channels over WebSocket (text frames, JSON payloads).
The wire-event identifiers are public protocol literals — they are not
secrets and do not depend on any specific backend vendor.
"""

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("hermes_plugins.onepilot")

PLUGIN_DIR = Path(__file__).resolve().parent
CONFIG_PATH = PLUGIN_DIR / "config.json"

HISTORY_LIMIT = 20

# Phoenix wire-protocol literals. Public identifiers, not secrets.
_WIRE_TOPIC_PREFIX = "realtime:"
_WIRE_EVENT_CHANGES = "postgres_changes"

# Cron-channel patch sentinel. Hermes can call register() more than once
# in long-lived processes (plugin reload during dev); the install function
# is a no-op after the first successful call.
_CRON_PATCHED = False


class _TerminalAuthError(Exception):
    """Raised when the agent key is revoked or otherwise permanently invalid."""


def register(ctx) -> None:
    """Plugin entry point. Hermes calls this once at gateway startup.

    The `ctx` argument is a PluginContext; we don't currently use any of its
    APIs (no tools, no hooks, no skills) — the plugin is a self-contained
    bridge that talks to the backend and the local API server. We accept it
    so the signature matches what `_load_plugin` expects.
    """
    if not CONFIG_PATH.exists():
        logger.warning("[onepilot] %s missing — plugin idle", CONFIG_PATH)
        return

    try:
        config = json.loads(CONFIG_PATH.read_text())
    except Exception as exc:  # pragma: no cover — surface at startup, not a crash
        logger.error("[onepilot] config.json parse failed: %s", exc)
        return

    required = {
        "backendUrl", "streamUrl", "publishableKey", "agentKey",
        "userId", "agentProfileId", "sessionKey",
    }
    missing = required - set(config.keys())
    if missing:
        logger.error("[onepilot] config.json missing keys: %s — plugin idle", sorted(missing))
        return

    if config.get("enabled") is False:
        logger.info("[onepilot] plugin disabled in config")
        return

    # Install the cron-delivery channel BEFORE spawning the inbound thread.
    # Hermes loads plugins during gateway init, before the cron tick thread
    # exists, so any patch installed here is visible the first time a cron
    # fires. If the install fails (Hermes internals moved), cron jobs sent
    # to deliver=onepilot will surface the failure on the job's last_error
    # field — visible in the iOS cron UI — instead of silently disappearing.
    _install_cron_channel(config)

    # The plugin's lifecycle is independent of Hermes' event loop — it talks
    # to the backend realtime stream over a websocket and posts back to Hermes' local
    # HTTP API server (http://127.0.0.1:<API_SERVER_PORT>), not to Hermes
    # internals. We previously did `asyncio.get_event_loop().create_task(...)`
    # but on Python 3.11+ that returns a throwaway loop because Hermes calls
    # `register()` BEFORE its gateway loop starts. The task got GC'd as
    # "Task was destroyed but it is pending! coroutine '_run' was never
    # awaited", so messages sent from the iOS app went into a black hole.
    # Fix: spawn a dedicated daemon thread with its own asyncio loop. The
    # thread exits with the gateway process.
    import threading

    def _thread_main() -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(_run(config))
        except Exception as exc:  # pragma: no cover — surface via logs
            logger.error("[onepilot] plugin thread crashed: %s", exc)
        finally:
            loop.close()

    threading.Thread(
        target=_thread_main,
        name="onepilot-plugin",
        daemon=True,
    ).start()

    user_short = str(config["userId"])[:8]
    agent_short = str(config["agentProfileId"])[:8]
    logger.info("[onepilot] plugin scheduled (user=%s agent=%s)", user_short, agent_short)


def _install_cron_channel(config: dict[str, Any]) -> None:
    """Register `onepilot` as a cron delivery channel by patching cron.scheduler.

    Hermes' cron scheduler validates the deliver target against
    `_KNOWN_DELIVERY_PLATFORMS` (a frozenset) and dispatches via
    `_deliver_result`. Both are module-level attributes; the production call
    site at `cron/scheduler.py:_process_job` looks `_deliver_result` up by
    module attribute on each tick, so rebinding it from here is picked up.

    The wrapper is targeted: anything whose deliver string does not name
    `onepilot` is delegated to the original implementation untouched.
    Telegram/Slack/Matrix etc. continue to dispatch through Hermes' built-in
    adapter map.

    Failure modes:
      * `cron.scheduler` import fails → log once and return; cron behaves
        as it does today (jobs sent to onepilot fail at fire time with
        Hermes' built-in "unknown platform" error, surfaced in last_error).
      * Required symbols missing (Hermes upgrade renamed something) →
        log once and return; same fallback behavior as above.
    """
    global _CRON_PATCHED
    if _CRON_PATCHED:
        return
    try:
        import cron.scheduler as _sched
    except Exception as exc:
        logger.warning(
            "[onepilot] cron.scheduler import failed (%s); cron channel disabled", exc
        )
        return

    if not hasattr(_sched, "_KNOWN_DELIVERY_PLATFORMS") or not hasattr(
        _sched, "_deliver_result"
    ):
        logger.warning(
            "[onepilot] hermes cron internals changed; cron channel disabled"
        )
        return

    try:
        _sched._KNOWN_DELIVERY_PLATFORMS = _sched._KNOWN_DELIVERY_PLATFORMS | frozenset(
            {"onepilot"}
        )
    except Exception as exc:
        logger.warning(
            "[onepilot] failed to extend _KNOWN_DELIVERY_PLATFORMS (%s); cron channel disabled",
            exc,
        )
        return

    _orig_deliver = _sched._deliver_result

    def _patched(job, content, adapters=None, loop=None):
        # Cron's `deliver` field is a comma-separated list of platform[:dest]
        # entries (scheduler.py:_resolve_delivery_targets). We only intercept
        # if onepilot appears as one of the platforms; everything else
        # continues to flow through the original dispatcher.
        deliver = str(job.get("deliver", "") or "")
        platform_names = [
            part.strip().split(":", 1)[0]
            for part in deliver.split(",")
            if part.strip()
        ]
        if "onepilot" not in platform_names:
            return _orig_deliver(job, content, adapters=adapters, loop=loop)

        # Hermes' silent-marker convention: agent prefixes output with [SILENT]
        # to skip delivery while still saving locally.
        if content and content.lstrip().startswith("[SILENT]"):
            return None

        try:
            err = _onepilot_deliver_sync(job, content, config)
        except Exception as exc:
            err = f"onepilot delivery failed: {exc}"
        if err:
            logger.warning("[onepilot] cron %s delivery failed: %s", job.get("id", "?"), err)
        return err

    _sched._deliver_result = _patched
    _CRON_PATCHED = True
    logger.info("[onepilot] cron delivery channel installed")


def _onepilot_deliver_sync(job: dict, content: str, config: dict[str, Any]) -> Optional[str]:
    """Drive the async ingest call from the synchronous cron-tick thread.

    Mirrors the dual-path strategy Hermes itself uses for standalone
    delivery (cron/scheduler.py): run a fresh event loop in the current
    thread, or fall back to a worker thread if one is already running.
    Returns None on success or an error string the scheduler stores in
    `last_error` so the iOS UI can surface it.
    """
    import concurrent.futures

    coro = _onepilot_deliver(job, content, config)
    try:
        return asyncio.run(coro)
    except RuntimeError:
        # asyncio.run refuses if a loop is already running in this thread.
        coro.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(asyncio.run, _onepilot_deliver(job, content, config))
            return future.result(timeout=120)


async def _onepilot_deliver(
    job: dict, content: str, config: dict[str, Any]
) -> Optional[str]:
    """POST cron output to agent-message-ingest as an assistant message.

    Resolves the destination session from the deliver string
    (`onepilot:<sessionKey>`), or falls back to the config's default
    session — Onepilot's one-agent-one-thread model means the default
    is almost always correct. Reuses the same retry curve as the inbound
    chat path because it hits the same endpoint with the same auth.
    """
    import httpx

    deliver = str(job.get("deliver", "") or "")
    session_key = config["sessionKey"]
    for part in deliver.split(","):
        part = part.strip()
        if part.startswith("onepilot:"):
            tail = part.split(":", 1)[1].strip()
            if tail:
                session_key = tail
            break

    job_name = str(job.get("name") or job.get("id") or "").strip()
    text = content or ""
    if job_name:
        text = f"**{job_name}**\n\n{text}"

    body = {
        "userId": str(config["userId"]).lower(),
        "agentProfileId": str(config["agentProfileId"]).lower(),
        "sessionKey": session_key,
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "timestamp": int(time.time() * 1000),
    }
    url = f"{config['backendUrl']}/functions/v1/agent-message-ingest"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config['agentKey']}",
    }
    body_str = json.dumps(body)

    delays = [0.25, 0.75]  # transient 5xx retry curve, matches _handle_user_message
    for attempt in range(len(delays) + 1):
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                r = await client.post(url, headers=headers, content=body_str)
            if r.status_code == 200:
                logger.info(
                    "[onepilot] cron '%s' delivered (%d chars)",
                    job.get("id", "?"),
                    len(text),
                )
                return None
            if r.status_code < 500 or attempt == len(delays):
                return f"ingest {r.status_code}: {r.text[:200]}"
        except Exception as exc:
            if attempt == len(delays):
                return f"ingest network error: {exc}"
        await asyncio.sleep(delays[attempt])
    return "ingest exhausted retries"


async def _run(config: dict[str, Any]) -> None:
    """Outer reconnect loop. Catches transient errors, surrenders on terminal."""
    backoff = 1.0
    while True:
        try:
            await _connect_and_subscribe(config)
            backoff = 1.0  # clean exit (reconnect requested) — reset
        except _TerminalAuthError as exc:
            logger.error("[onepilot] terminal auth: %s — channel idle", exc)
            return
        except Exception as exc:
            logger.warning("[onepilot] subscription error: %s — reconnect in %.0fs", exc, backoff)
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 30.0)


async def _fetch_stream_token(config: dict[str, Any]) -> tuple[str, float]:
    """Exchange the durable agent key for a short-lived stream JWT.

    Returns (token, exp_ms). Raises _TerminalAuthError on revoked-key 401 or
    other 4xx that won't recover by retrying.
    """
    import httpx  # imported lazily so import errors only bite if the plugin runs
    url = f"{config['backendUrl']}/functions/v1/agent-stream-token"
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            url,
            headers={"Authorization": f"Bearer {config['agentKey']}"},
        )
    body_preview = r.text[:200] if r.text else ""
    if r.status_code == 401 and "revoked" in body_preview.lower():
        raise _TerminalAuthError(f"key revoked: {body_preview}")
    if 400 <= r.status_code < 500 and r.status_code != 429:
        raise _TerminalAuthError(f"auth fetch {r.status_code}: {body_preview}")
    r.raise_for_status()
    j = r.json()
    if not j.get("token") or not j.get("expires_at"):
        raise RuntimeError("stream token response missing token/expires_at")
    return j["token"], float(j["expires_at"]) * 1000.0


async def _connect_and_subscribe(config: dict[str, Any]) -> None:
    """One websocket lifetime. Returns cleanly to trigger reconnect."""
    import websockets  # type: ignore[import-not-found]

    token, exp_ms = await _fetch_stream_token(config)

    stream_url = config["streamUrl"]
    if stream_url.startswith("https://"):
        ws_base = "wss://" + stream_url[len("https://"):]
    elif stream_url.startswith("http://"):
        ws_base = "ws://" + stream_url[len("http://"):]
    else:
        ws_base = stream_url

    schema = "public"
    table = "messages"
    user_id_lc = str(config["userId"]).lower()
    agent_id_lc = str(config["agentProfileId"]).lower()
    row_filter = f"user_id=eq.{user_id_lc}"
    socket_url = (
        f"{ws_base}/realtime/v1/websocket"
        f"?apikey={config['publishableKey']}&vsn=1.0.0"
    )

    ref_counter = [1]

    def next_ref() -> str:
        v = str(ref_counter[0])
        ref_counter[0] += 1
        return v

    async with websockets.connect(socket_url) as ws:
        topic = f"{_WIRE_TOPIC_PREFIX}{schema}:{table}"
        join_ref = next_ref()
        join_payload = {
            "config": {
                "broadcast": {"self": False},
                "presence": {"key": ""},
                _WIRE_EVENT_CHANGES: [
                    {
                        "event": "INSERT",
                        "schema": schema,
                        "table": table,
                        "filter": row_filter,
                    }
                ],
            },
            "access_token": token,
        }
        await ws.send(json.dumps({
            "topic": topic,
            "event": "phx_join",
            "payload": join_payload,
            "ref": join_ref,
            "join_ref": join_ref,
        }))

        async def heartbeat() -> None:
            while True:
                await asyncio.sleep(30)
                try:
                    await ws.send(json.dumps({
                        "topic": "phoenix",
                        "event": "heartbeat",
                        "payload": {},
                        "ref": next_ref(),
                    }))
                except Exception:
                    return

        async def renew_token() -> None:
            nonlocal exp_ms
            while True:
                # Renew 60s before server-side expiry. Sleep at least 30s
                # to avoid tight loops if exp_ms is somehow already close.
                wait_s = max(30.0, (exp_ms - time.time() * 1000) / 1000.0 - 60.0)
                await asyncio.sleep(wait_s)
                try:
                    new_token, new_exp = await _fetch_stream_token(config)
                except _TerminalAuthError:
                    raise
                except Exception as exc:
                    logger.warning("[onepilot] token renew failed: %s — closing socket", exc)
                    await ws.close()
                    return
                exp_ms = new_exp
                try:
                    await ws.send(json.dumps({
                        "topic": topic,
                        "event": "access_token",
                        "payload": {"access_token": new_token},
                        "ref": next_ref(),
                    }))
                except Exception:
                    return

        hb_task = asyncio.create_task(heartbeat())
        renew_task = asyncio.create_task(renew_token())
        try:
            async for raw in ws:
                try:
                    frame = json.loads(raw)
                except Exception:
                    continue
                event = frame.get("event")
                if event == _WIRE_EVENT_CHANGES:
                    payload = (frame.get("payload") or {}).get("data") or {}
                    if payload.get("type") != "INSERT":
                        continue
                    record = payload.get("record") or {}
                    # Defense in depth: server-side row filtering already
                    # restricts to this user_id, but check agent_profile_id
                    # ourselves so a second deployed agent doesn't pick up
                    # another's rows.
                    if str(record.get("agent_profile_id", "")).lower() != agent_id_lc:
                        continue
                    if record.get("role") != "user":
                        continue
                    # source="webhook" is what we write back as assistant —
                    # plain dedupe so we don't re-process our own rows if
                    # the role check ever falls through.
                    if str(record.get("source") or "").lower() == "webhook":
                        continue
                    asyncio.create_task(_handle_user_message(config, record))
                elif event == "phx_reply":
                    pl = frame.get("payload") or {}
                    if pl.get("status") == "error":
                        logger.warning("[onepilot] phx_reply error: %s", str(pl)[:200])
                elif event == "system":
                    pl = frame.get("payload") or {}
                    if pl.get("status") == "error":
                        msg = str(pl.get("message") or "").lower()
                        logger.warning("[onepilot] system error: %s", str(pl)[:200])
                        if "token" in msg and "expir" in msg:
                            # Push a fresh token; renew_token will catch up.
                            try:
                                new_token, new_exp = await _fetch_stream_token(config)
                                exp_ms = new_exp
                                await ws.send(json.dumps({
                                    "topic": topic,
                                    "event": "access_token",
                                    "payload": {"access_token": new_token},
                                    "ref": next_ref(),
                                }))
                            except _TerminalAuthError:
                                raise
                            except Exception:
                                await ws.close()
        finally:
            hb_task.cancel()
            renew_task.cancel()


async def _handle_user_message(config: dict[str, Any], row: dict[str, Any]) -> None:
    """Dispatch one user message to Hermes' API server, post the reply back."""
    import httpx

    session_id = row.get("session_id")
    if not session_id:
        return

    try:
        history = await _load_history(config, session_id)
    except Exception as exc:
        logger.warning("[onepilot] history fetch failed: %s", exc)
        return

    # If a foreground client (the Onepilot app, while open) already answered, skip.
    user_created = row.get("created_at") or ""
    for h in history:
        if (
            h.get("role") == "assistant"
            and isinstance(h.get("created_at"), str)
            and isinstance(user_created, str)
            and h["created_at"] > user_created
        ):
            return

    messages = _normalize_history(history)
    if not messages:
        # Edge case: history endpoint returned empty but we got a row from
        # the inbound stream. Fall back to using the row's content directly.
        text = _extract_text(row.get("content"))
        if text:
            messages = [{"role": "user", "content": text}]
        else:
            return

    api_port = int(os.environ.get("API_SERVER_PORT", "8642"))
    completion_url = f"http://127.0.0.1:{api_port}/v1/chat/completions"
    try:
        # No timeout on the read: agent runs can take many minutes. The
        # caller is in-process with the gateway, so there is no external
        # client to disconnect. Connect/write timeouts are short to surface
        # config breakage fast.
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10.0, read=None, write=10.0, pool=10.0)
        ) as client:
            r = await client.post(
                completion_url,
                headers={"Content-Type": "application/json"},
                json={"model": "hermes-agent", "messages": messages, "stream": False},
            )
    except Exception as exc:
        logger.warning("[onepilot] api_server call failed: %s", exc)
        return

    if r.status_code != 200:
        logger.warning("[onepilot] api_server %d: %s", r.status_code, r.text[:200])
        return

    try:
        completion = r.json()
    except Exception as exc:
        logger.warning("[onepilot] api_server response parse failed: %s", exc)
        return
    reply = _extract_assistant_text(completion)
    if not reply:
        logger.warning("[onepilot] api_server returned no assistant text")
        return

    # Post back to the ingest endpoint. Server-side, the agent key is bound
    # to (user_id, agent_profile_id); a request whose body claims a different
    # user or agent is rejected. UUIDs lowercased to canonical form.
    ingest_body = {
        "userId": str(config["userId"]).lower(),
        "agentProfileId": str(config["agentProfileId"]).lower(),
        "sessionKey": row.get("session_key") or config["sessionKey"],
        "role": "assistant",
        "content": [{"type": "text", "text": reply}],
        "timestamp": int(time.time() * 1000),
    }
    ingest_url = f"{config['backendUrl']}/functions/v1/agent-message-ingest"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config['agentKey']}",
    }
    body_str = json.dumps(ingest_body)

    delays = [0.25, 0.75]  # transient 5xx retry curve
    last_status = None
    for attempt in range(len(delays) + 1):
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                r = await client.post(ingest_url, headers=headers, content=body_str)
            last_status = r.status_code
            if r.status_code < 500 or attempt == len(delays):
                if r.status_code != 200:
                    logger.warning("[onepilot] ingest %d: %s", r.status_code, r.text[:200])
                else:
                    logger.info("[onepilot] reply delivered (%d chars)", len(reply))
                return
            logger.warning("[onepilot] ingest %d (attempt %d) — retrying", r.status_code, attempt + 1)
        except Exception as exc:
            if attempt == len(delays):
                logger.warning("[onepilot] ingest network error: %s", exc)
                return
            logger.warning("[onepilot] ingest network error (attempt %d): %s — retrying", attempt + 1, exc)
        await asyncio.sleep(delays[attempt])


async def _load_history(config: dict[str, Any], session_id: str) -> list[dict[str, Any]]:
    import httpx

    url = (
        f"{config['backendUrl']}/functions/v1/agent-message-history"
        f"?session_id={session_id}&limit={HISTORY_LIMIT}"
    )
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            url,
            headers={"Authorization": f"Bearer {config['agentKey']}"},
        )
    if r.status_code != 200:
        raise RuntimeError(f"history {r.status_code}: {r.text[:200]}")
    j = r.json()
    msgs = j.get("messages") or []
    return msgs if isinstance(msgs, list) else []


def _normalize_history(rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for row in reversed(rows):
        text = _extract_text(row.get("content"))
        if text:
            out.append({"role": row.get("role", "user"), "content": text})
    return out


def _extract_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        try:
            parsed = json.loads(content)
        except Exception:
            return content
        return _extract_text(parsed)
    if isinstance(content, list):
        for p in content:
            if isinstance(p, dict):
                ptype = p.get("type")
                if (ptype == "text" or ptype is None) and isinstance(p.get("text"), str):
                    return p["text"]
        return ""
    if isinstance(content, dict) and isinstance(content.get("text"), str):
        return content["text"]
    return ""


def _extract_assistant_text(completion: dict[str, Any]) -> str:
    choices = completion.get("choices") or []
    if not choices:
        return ""
    msg = (choices[0] or {}).get("message") or {}
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for p in content:
            if isinstance(p, dict):
                ptype = p.get("type")
                if (ptype == "text" or ptype is None) and isinstance(p.get("text"), str):
                    return p["text"]
    return ""
