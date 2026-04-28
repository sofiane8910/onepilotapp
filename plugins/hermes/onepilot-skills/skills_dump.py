#!/usr/bin/env python3
"""Onepilot Skills plugin entry. See SECURITY.md for invariants."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

PLUGIN_VERSION = "0.1.0"

# Path-traversal defense: regex + segment scan in `_validate_name`.
_NAME_RE = re.compile(r"^[A-Za-z0-9_./\-]{1,200}$")


def _emit(envelope: dict) -> int:
    json.dump(envelope, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


def _error_envelope(error_class: str, **extra) -> dict:
    return {"plugin_version": PLUGIN_VERSION, "error": error_class, **extra}


def _validate_name(raw: str) -> str | None:
    if not isinstance(raw, str):
        return None
    if not _NAME_RE.match(raw):
        return None
    parts = raw.split("/")
    if any(p in ("", "..", ".") for p in parts):
        return None
    return raw


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="skills_dump")
    parser.add_argument("--mode", choices=("installed", "hub", "inspect"), required=True)
    parser.add_argument("--name", type=str, default=None)
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--page-size", dest="page_size", type=int, default=100)
    parser.add_argument("--source", type=str, default="all")
    args = parser.parse_args(argv)

    try:
        if args.mode == "installed":
            from skill_lib.installed import collect_installed
            return _emit(collect_installed(plugin_version=PLUGIN_VERSION))

        if args.mode == "hub":
            from skill_lib.hub import browse
            return _emit(browse(
                plugin_version=PLUGIN_VERSION,
                page=args.page,
                page_size=args.page_size,
                source=args.source,
            ))

        if args.mode == "inspect":
            validated = _validate_name(args.name) if args.name else None
            if validated is None:
                return _emit(_error_envelope("invalid_name", skill=None))
            from skill_lib.hub import inspect
            return _emit(inspect(plugin_version=PLUGIN_VERSION, name=validated))

        return _emit(_error_envelope("unknown_mode"))

    except Exception as e:
        return _emit(_error_envelope(type(e).__name__))


if __name__ == "__main__":
    raise SystemExit(main())
