#!/usr/bin/env python3
"""Standalone catalog dumper, invoked by the Onepilot iOS app over SSH."""

from __future__ import annotations

import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from catalog import build_catalog  # noqa: E402


def main() -> int:
    catalog = build_catalog()
    json.dump(catalog, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
