from __future__ import annotations

import json
from pathlib import Path

import pytest

from skill_lib import installed as installed_mod


def make_skill_dir(root: Path, name: str, body: str = "# Skill\n") -> Path:
    skill_dir = root / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(body)
    return skill_dir


@pytest.fixture
def fake_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home" / "user"
    hermes = home / ".hermes"
    (hermes / "skills").mkdir(parents=True)
    (hermes / "profiles" / "coder" / "skills").mkdir(parents=True)
    (hermes / "skills" / ".hub").mkdir(parents=True)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.setenv("HERMES_HOME", str(hermes / "profiles" / "coder"))
    return hermes


def test_filesystem_walk_finds_host_and_profile_skills(fake_home: Path, monkeypatch):
    make_skill_dir(fake_home / "skills", "writer")
    make_skill_dir(fake_home / "skills", "shared")
    make_skill_dir(fake_home / "profiles" / "coder" / "skills", "shared")  # collision: profile shadows host
    make_skill_dir(fake_home / "profiles" / "coder" / "skills", "coder-helper")

    monkeypatch.setattr(installed_mod, "_safe_scan_descriptions", lambda: {})
    out = installed_mod.collect_installed(plugin_version="0.1.0")

    assert out["plugin_version"] == "0.1.0"
    names = {s["name"]: s for s in out["skills"]}
    assert set(names.keys()) == {"writer", "shared", "coder-helper"}
    assert names["shared"]["scope"] == "profile"
    assert names["shared"]["bundled"] is False
    assert names["writer"]["scope"] == "host"
    assert names["writer"]["bundled"] is True
    assert names["coder-helper"]["scope"] == "profile"


def test_descriptions_layered_from_hermes_scan(fake_home: Path, monkeypatch):
    make_skill_dir(fake_home / "skills", "writer")
    make_skill_dir(fake_home / "skills", "researcher")

    monkeypatch.setattr(
        installed_mod,
        "_safe_scan_descriptions",
        lambda: {"writer": "Drafts long-form posts", "researcher": "Web research"},
    )
    out = installed_mod.collect_installed(plugin_version="0.1.0")
    by_name = {s["name"]: s for s in out["skills"]}
    assert by_name["writer"]["description"] == "Drafts long-form posts"
    assert by_name["researcher"]["description"] == "Web research"


def test_disabled_propagates_from_config_yaml(fake_home: Path, monkeypatch):
    make_skill_dir(fake_home / "skills", "writer")
    make_skill_dir(fake_home / "skills", "researcher")
    (fake_home / "config.yaml").write_text(
        "skills:\n  disabled:\n    - researcher\n"
    )
    monkeypatch.setattr(installed_mod, "_safe_scan_descriptions", lambda: {})

    out = installed_mod.collect_installed(plugin_version="0.1.0")
    by_name = {s["name"]: s for s in out["skills"]}
    assert by_name["writer"]["disabled"] is False
    assert by_name["writer"]["hostDisabled"] is None
    assert by_name["researcher"]["disabled"] is True
    assert by_name["researcher"]["hostDisabled"] is True


def test_lock_json_populates_registry_source(fake_home: Path, monkeypatch):
    make_skill_dir(fake_home / "skills", "writer")
    make_skill_dir(fake_home / "skills", "researcher")
    make_skill_dir(fake_home / "skills", "manual-only")

    lock = {
        "version": 1,
        "installed": {
            "writer": {"source": "official", "identifier": "official/productivity/writer"},
            "researcher": {"source": "clawhub", "identifier": "researcher"},
        },
    }
    (fake_home / "skills" / ".hub" / "lock.json").write_text(json.dumps(lock))
    monkeypatch.setattr(installed_mod, "_safe_scan_descriptions", lambda: {})

    out = installed_mod.collect_installed(plugin_version="0.1.0")
    by_name = {s["name"]: s for s in out["skills"]}
    assert by_name["writer"]["registrySource"] == "official"
    assert by_name["researcher"]["registrySource"] == "clawhub"
    assert by_name["manual-only"]["registrySource"] is None


def test_malformed_lock_yields_no_registry_data(fake_home: Path, monkeypatch):
    make_skill_dir(fake_home / "skills", "writer")
    (fake_home / "skills" / ".hub" / "lock.json").write_text("not json at all")
    monkeypatch.setattr(installed_mod, "_safe_scan_descriptions", lambda: {})

    out = installed_mod.collect_installed(plugin_version="0.1.0")
    assert out["skills"][0]["registrySource"] is None


def test_envelope_always_carries_plugin_version(fake_home: Path, monkeypatch):
    monkeypatch.setattr(installed_mod, "_safe_scan_descriptions", lambda: {})
    out = installed_mod.collect_installed(plugin_version="0.1.0")
    assert out["plugin_version"] == "0.1.0"
    assert out["skills"] == []
    assert out["count"] == 0
