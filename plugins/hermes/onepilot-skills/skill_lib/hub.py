"""Plugin/app boundary. Hermes' raw field names live here only — iOS sees canonical names.

Translations: `trust` → `trustLevel`, `skill_md_preview` → `skillMdPreview`.
A Hermes upstream rename is a one-line patch in the `_translate_*` helpers.
"""

from __future__ import annotations

from typing import Any, Optional


def _import_hub():
    try:
        from hermes_cli.skills_hub import browse_skills, inspect_skill
        return browse_skills, inspect_skill
    except ImportError:
        return None, None


def _translate_browse_item(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {"name": "", "description": "", "source": "", "trustLevel": "community", "tags": []}
    tags_raw = raw.get("tags", [])
    if not isinstance(tags_raw, list):
        tags_raw = []
    return {
        "name": str(raw.get("name", "")),
        "description": str(raw.get("description", "")),
        "source": str(raw.get("source", "")),
        "trustLevel": str(raw.get("trust", "community")),
        "tags": [str(t) for t in tags_raw if isinstance(t, (str, int))],
    }


def _translate_inspect_skill(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict) or not raw:
        return None
    tags_raw = raw.get("tags", [])
    if not isinstance(tags_raw, list):
        tags_raw = []
    out: dict[str, Any] = {
        "name": str(raw.get("name", "")),
        "description": str(raw.get("description", "")),
        "source": str(raw.get("source", "")),
        "trustLevel": str(raw.get("trust", "community")),
        "identifier": str(raw.get("identifier", "")),
        "tags": [str(t) for t in tags_raw if isinstance(t, (str, int))],
    }
    preview = raw.get("skill_md_preview")
    if isinstance(preview, str) and preview:
        out["skillMdPreview"] = preview
    return out


def browse(
    plugin_version: str,
    page: int = 1,
    page_size: int = 100,
    source: str = "all",
) -> dict[str, Any]:
    browse_skills, _ = _import_hub()
    if browse_skills is None:
        return {
            "plugin_version": plugin_version,
            "items": [],
            "page": 1,
            "total_pages": 1,
            "total": 0,
            "error": "hermes_unavailable",
        }

    page = max(1, min(int(page), 1000))
    page_size = max(1, min(int(page_size), 100))
    if not isinstance(source, str) or len(source) > 32:
        source = "all"

    try:
        result = browse_skills(page=page, page_size=page_size, source=source)
    except Exception as e:
        return {
            "plugin_version": plugin_version,
            "items": [],
            "page": page,
            "total_pages": 1,
            "total": 0,
            "error": type(e).__name__,
        }

    if not isinstance(result, dict):
        return {
            "plugin_version": plugin_version,
            "items": [],
            "page": page,
            "total_pages": 1,
            "total": 0,
            "error": "unexpected_shape",
        }

    raw_items = result.get("items", [])
    if not isinstance(raw_items, list):
        raw_items = []
    return {
        "plugin_version": plugin_version,
        "items": [_translate_browse_item(it) for it in raw_items],
        "page": result.get("page", page),
        "total_pages": result.get("total_pages", 1),
        "total": result.get("total", 0),
    }


def inspect(plugin_version: str, name: str) -> dict[str, Any]:
    _, inspect_skill = _import_hub()
    if inspect_skill is None:
        return {
            "plugin_version": plugin_version,
            "skill": None,
            "error": "hermes_unavailable",
        }

    if not isinstance(name, str) or not name:
        return {
            "plugin_version": plugin_version,
            "skill": None,
            "error": "invalid_name",
        }

    try:
        result = inspect_skill(name)
    except Exception as e:
        return {
            "plugin_version": plugin_version,
            "skill": None,
            "error": type(e).__name__,
        }

    if result is None:
        return {"plugin_version": plugin_version, "skill": None}

    if not isinstance(result, dict):
        return {
            "plugin_version": plugin_version,
            "skill": None,
            "error": "unexpected_shape",
        }

    return {"plugin_version": plugin_version, "skill": _translate_inspect_skill(result)}
