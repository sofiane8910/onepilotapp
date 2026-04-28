"""Onepilot channel plugin for Hermes — chat I/O + cron delivery."""

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

_WIRE_TOPIC_PREFIX = "realtime:"
_WIRE_EVENT_CHANGES = "postgres_changes"

_CRON_PATCHED = False


class _TerminalAuthError(Exception):
    pass


def register(ctx) -> None:
    if not CONFIG_PATH.exists():
        logger.warning("[onepilot] %s missing — plugin idle", CONFIG_PATH)
        return

    try:
        config = json.loads(CONFIG_PATH.read_text())
    except Exception as exc:
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

    _install_cron_channel(config)

    import threading

    def _thread_main() -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(_run(config))
        except Exception as exc:
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
    """Register `onepilot` as a cron delivery channel by patching cron.scheduler."""
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
        deliver = str(job.get("deliver", "") or "")
        platform_names = [
            part.strip().split(":", 1)[0]
            for part in deliver.split(",")
            if part.strip()
        ]
        if "onepilot" not in platform_names:
            return _orig_deliver(job, content, adapters=adapters, loop=loop)

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
    import concurrent.futures

    coro = _onepilot_deliver(job, content, config)
    try:
        return asyncio.run(coro)
    except RuntimeError:
        coro.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(asyncio.run, _onepilot_deliver(job, content, config))
            return future.result(timeout=120)


async def _onepilot_deliver(
    job: dict, content: str, config: dict[str, Any]
) -> Optional[str]:
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

    delays = [0.25, 0.75]
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
    backoff = 1.0
    while True:
        try:
            await _connect_and_subscribe(config)
            backoff = 1.0
        except _TerminalAuthError as exc:
            logger.error("[onepilot] terminal auth: %s — channel idle", exc)
            return
        except Exception as exc:
            logger.warning("[onepilot] subscription error: %s — reconnect in %.0fs", exc, backoff)
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 30.0)


async def _fetch_stream_token(config: dict[str, Any]) -> tuple[str, float]:
    import httpx
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
                    if str(record.get("agent_profile_id", "")).lower() != agent_id_lc:
                        continue
                    if record.get("role") != "user":
                        continue
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
    import httpx

    session_id = row.get("session_id")
    if not session_id:
        return

    try:
        history = await _load_history(config, session_id)
    except Exception as exc:
        logger.warning("[onepilot] history fetch failed: %s", exc)
        return

    # Skip if a foreground client (the open Onepilot app) already answered.
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
        text = _extract_text(row.get("content"))
        if text:
            messages = [{"role": "user", "content": text}]
        else:
            return

    api_port = int(os.environ.get("API_SERVER_PORT", "8642"))
    completion_url = f"http://127.0.0.1:{api_port}/v1/chat/completions"
    try:
        # No read timeout — agent runs can take many minutes.
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

    delays = [0.25, 0.75]
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
