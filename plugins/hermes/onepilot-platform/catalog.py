"""Slash-command catalog builder for the Onepilot iOS app."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("hermes_plugins.onepilot.catalog")

# Mirrors hermes/tui_gateway/server.py:_TUI_HIDDEN — kept in sync manually.
_TUI_HIDDEN: frozenset[str] = frozenset(
    {"sethome", "set-home", "update", "commands", "status", "approve", "deny"}
)

_TUI_EXTRA: list[tuple[str, str, str]] = [
    ("/compact", "Toggle compact display mode", "TUI"),
    ("/logs", "Show recent gateway log lines", "TUI"),
]


def build_catalog() -> dict[str, Any]:
    pairs: list[list[str]] = []
    canon: dict[str, str] = {}
    cat_map: dict[str, list[list[str]]] = {}
    cat_order: list[str] = []
    warning = ""

    try:
        from hermes_cli.commands import (
            COMMAND_REGISTRY,
            SUBCOMMANDS,
            _build_description,
        )
    except Exception as e:
        return {
            "pairs": [],
            "categories": [],
            "canon": {},
            "sub": {},
            "skill_count": 0,
            "warning": f"hermes_cli.commands unavailable: {e}",
        }

    for cmd in COMMAND_REGISTRY:
        c = f"/{cmd.name}"
        canon[c.lower()] = c
        for a in cmd.aliases:
            canon[f"/{a}".lower()] = c
        if cmd.name in _TUI_HIDDEN:
            continue
        try:
            desc = _build_description(cmd)
        except Exception:
            desc = cmd.description or ""
        pairs.append([c, desc])
        cat_map.setdefault(cmd.category, []).append([c, desc])
        if cmd.category not in cat_order:
            cat_order.append(cmd.category)

    for name, desc, cat in _TUI_EXTRA:
        pairs.append([name, desc])
        cat_map.setdefault(cat, []).append([name, desc])
        if cat not in cat_order:
            cat_order.append(cat)

    try:
        from hermes_cli.config import load_config

        cfg = load_config() or {}
        qcmds = cfg.get("quick_commands") or {}
        if isinstance(qcmds, dict) and qcmds:
            bucket = "User commands"
            cat_map.setdefault(bucket, [])
            if bucket not in cat_order:
                cat_order.append(bucket)
            for qname, qc in sorted(qcmds.items()):
                if not isinstance(qc, dict):
                    continue
                key = f"/{qname}"
                canon[key.lower()] = key
                qtype = qc.get("type", "")
                if qtype == "exec":
                    default_desc = f"exec: {qc.get('command', '')}"
                elif qtype == "alias":
                    default_desc = f"alias → {qc.get('target', '')}"
                else:
                    default_desc = qtype or "quick command"
                qdesc = str(qc.get("description") or default_desc)
                qdesc = qdesc[:120] + ("…" if len(qdesc) > 120 else "")
                pairs.append([key, qdesc])
                cat_map[bucket].append([key, qdesc])
    except Exception as e:
        warning = warning or f"quick_commands unavailable: {e}"

    skill_count = 0
    try:
        from agent.skill_commands import scan_skill_commands

        for k, info in sorted(scan_skill_commands().items()):
            d = str(info.get("description", "Skill"))
            d = d[:120] + ("…" if len(d) > 120 else "")
            pairs.append([k, d])
            skill_count += 1
    except Exception as e:
        warning = f"skill discovery unavailable: {e}"

    sub = {k: list(v) for k, v in (SUBCOMMANDS or {}).items()}
    categories = [{"name": c, "pairs": cat_map[c]} for c in cat_order]
    return {
        "pairs": pairs,
        "categories": categories,
        "canon": canon,
        "sub": sub,
        "skill_count": skill_count,
        "warning": warning,
    }
