from __future__ import annotations

import sys
import types

import pytest

import skill_lib.hub as hub_mod


def _stub_hermes_module(browse_impl=None, inspect_impl=None):
    hermes_cli = types.ModuleType("hermes_cli")
    skills_hub = types.ModuleType("hermes_cli.skills_hub")
    skills_hub.browse_skills = browse_impl or (
        lambda page=1, page_size=20, source="all": {
            "items": [],
            "page": page,
            "total_pages": 1,
            "total": 0,
        }
    )
    skills_hub.inspect_skill = inspect_impl or (lambda name: None)
    hermes_cli.skills_hub = skills_hub
    sys.modules["hermes_cli"] = hermes_cli
    sys.modules["hermes_cli.skills_hub"] = skills_hub


@pytest.fixture(autouse=True)
def cleanup_hermes_modules():
    yield
    for k in ("hermes_cli", "hermes_cli.skills_hub"):
        sys.modules.pop(k, None)


def test_browse_translates_hermes_names_to_ios_canonical():
    fake = {
        "items": [
            {"name": "writer", "description": "Drafts", "source": "official", "trust": "builtin"},
            {"name": "researcher", "description": "Search", "source": "clawhub", "trust": "community", "tags": ["agent"]},
        ],
        "page": 1,
        "total_pages": 1,
        "total": 2,
    }

    def fake_browse(page, page_size, source):
        assert page == 1 and page_size == 50 and source == "all"
        return fake

    _stub_hermes_module(browse_impl=fake_browse)
    out = hub_mod.browse(plugin_version="0.1.0", page=1, page_size=50, source="all")

    assert out["plugin_version"] == "0.1.0"
    assert out["total"] == 2

    item = out["items"][0]
    assert "trust" not in item
    assert item["trustLevel"] == "builtin"
    assert item["name"] == "writer"
    assert item["tags"] == []

    item2 = out["items"][1]
    assert item2["trustLevel"] == "community"
    assert item2["tags"] == ["agent"]


def test_browse_translation_handles_malformed_items():
    def fake_browse(page, page_size, source):
        return {"items": [None, "not a dict", {"name": "ok", "trust": "builtin"}], "page": 1, "total_pages": 1, "total": 3}

    _stub_hermes_module(browse_impl=fake_browse)
    out = hub_mod.browse(plugin_version="0.1.0")
    assert len(out["items"]) == 3
    assert out["items"][0]["name"] == ""
    assert out["items"][0]["trustLevel"] == "community"
    assert out["items"][2]["name"] == "ok"
    assert out["items"][2]["trustLevel"] == "builtin"


def test_browse_clamps_pagination():
    seen = {}

    def fake_browse(page, page_size, source):
        seen.update(page=page, page_size=page_size, source=source)
        return {"items": [], "page": page, "total_pages": 1, "total": 0}

    _stub_hermes_module(browse_impl=fake_browse)
    hub_mod.browse(plugin_version="0.1.0", page=99999, page_size=99999, source="x" * 100)

    assert seen["page"] == 1000
    assert seen["page_size"] == 100
    assert seen["source"] == "all"


def test_browse_returns_error_envelope_on_hermes_failure():
    def boom(page, page_size, source):
        raise RuntimeError("registry timeout")

    _stub_hermes_module(browse_impl=boom)
    out = hub_mod.browse(plugin_version="0.1.0")
    assert out["items"] == []
    assert out["error"] == "RuntimeError"
    assert "registry timeout" not in str(out)  # exception message must not leak


def test_browse_handles_missing_hermes_module():
    out = hub_mod.browse(plugin_version="0.1.0")
    assert out["error"] == "hermes_unavailable"
    assert out["items"] == []


def test_inspect_translates_hermes_names_to_ios_canonical():
    fake = {
        "name": "writer",
        "description": "Drafts",
        "source": "official",
        "trust": "builtin",
        "identifier": "official/productivity/writer",
        "tags": ["docs"],
        "skill_md_preview": "# Writer\n\nUse this skill...",
    }
    _stub_hermes_module(inspect_impl=lambda name: fake if name == "writer" else None)
    out = hub_mod.inspect(plugin_version="0.1.0", name="writer")
    assert out["plugin_version"] == "0.1.0"

    skill = out["skill"]
    assert "trust" not in skill
    assert "skill_md_preview" not in skill
    assert skill["trustLevel"] == "builtin"
    assert skill["skillMdPreview"] == "# Writer\n\nUse this skill..."
    assert skill["identifier"] == "official/productivity/writer"
    assert skill["tags"] == ["docs"]


def test_inspect_omits_preview_when_hermes_doesnt_supply_one():
    fake = {"name": "writer", "description": "x", "source": "official", "identifier": "x", "trust": "builtin"}
    _stub_hermes_module(inspect_impl=lambda name: fake)
    out = hub_mod.inspect(plugin_version="0.1.0", name="writer")
    assert "skillMdPreview" not in out["skill"]


def test_inspect_handles_unknown_name():
    _stub_hermes_module(inspect_impl=lambda name: None)
    out = hub_mod.inspect(plugin_version="0.1.0", name="ghost")
    assert out["skill"] is None
    assert "error" not in out


def test_inspect_rejects_empty_name():
    _stub_hermes_module(inspect_impl=lambda name: {"name": name})
    out = hub_mod.inspect(plugin_version="0.1.0", name="")
    assert out["skill"] is None
    assert out["error"] == "invalid_name"


def test_inspect_handles_hermes_exception():
    def boom(name):
        raise PermissionError("/some/path/that/should/not/leak")

    _stub_hermes_module(inspect_impl=boom)
    out = hub_mod.inspect(plugin_version="0.1.0", name="writer")
    assert out["error"] == "PermissionError"
    assert "/some/path" not in str(out)
