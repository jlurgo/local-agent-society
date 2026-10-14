"""
Tests for cli/commands/_agent_common.py — the shared helpers extracted out of
cli/commands/agents.py (resolve_agent_name, infer_locale), plus regression
coverage for the OSError-wrapped .las-agent.json writes in `agent new`/`agent
restore`.
"""
import json

import click
import pytest
from click.testing import CliRunner

from cli.commands import _agent_common
from cli.commands import agents as agents_mod


# ---------------------------------------------------------------------------
# resolve_agent_name
# ---------------------------------------------------------------------------

def test_resolve_agent_name_returns_explicit_name_without_touching_cwd(monkeypatch):
    """If a name is explicitly given, it's returned as-is and cwd is never inspected."""
    def boom():
        raise AssertionError("should not look up cwd when name is given")

    monkeypatch.setattr(_agent_common, "_agent_name_from_cwd", boom)
    assert _agent_common.resolve_agent_name("explicit-name") == "explicit-name"


def test_resolve_agent_name_uses_the_registrys_spelling(monkeypatch):
    """`las agent sessions team-knowledge` answered "no connected sessions" for an
    agent registered as "Team Knowledge" (2026-10-14): the folder name is what
    people type. Case and punctuation don't count; an unknown name stays as typed."""
    monkeypatch.setattr(_agent_common.api, "get", lambda path: {"Team Knowledge": {}, "Robo": {}, "robo-two": {}})
    assert _agent_common.resolve_agent_name("team-knowledge") == "Team Knowledge"
    assert _agent_common.resolve_agent_name("TEAMKNOWLEDGE") == "Team Knowledge"
    assert _agent_common.resolve_agent_name("Robo") == "Robo"
    assert _agent_common.resolve_agent_name("nobody") == "nobody"
    assert _agent_common.canonical_agent_name("robotwo", ["robo-two", "Robo Two"]) == "robotwo"   # two matches: no guess


def test_resolve_agent_name_keeps_the_name_when_the_backend_is_down(monkeypatch):
    def down(path):
        raise SystemExit(1)
    monkeypatch.setattr(_agent_common.api, "get", down)
    assert _agent_common.resolve_agent_name("team-knowledge") == "team-knowledge"


def test_resolve_agent_name_falls_back_to_cwd(monkeypatch, tmp_path):
    """With no explicit name, it resolves from .las-agent.json in the cwd."""
    (tmp_path / ".las-agent.json").write_text(json.dumps({"name": "cwd-agent"}))
    monkeypatch.chdir(tmp_path)
    assert _agent_common.resolve_agent_name(None) == "cwd-agent"


def test_resolve_agent_name_never_reads_the_retired_agent_json(monkeypatch, tmp_path):
    """.agent.json (pre-rename) is retired: it no longer identifies an agent."""
    (tmp_path / ".agent.json").write_text(json.dumps({"name": "legacy-agent"}))
    monkeypatch.chdir(tmp_path)
    assert not (tmp_path / ".las-agent.json").exists()
    from cli.path_utils import agent_config_path
    assert agent_config_path(tmp_path) is None


def test_resolve_agent_name_errors_when_no_name_and_no_agent_json(monkeypatch, tmp_path):
    """Neither an explicit name nor a discoverable agent config -> SystemExit(1)."""
    monkeypatch.setattr(_agent_common, "_agent_name_from_cwd", lambda: None)
    with pytest.raises(SystemExit) as excinfo:
        _agent_common.resolve_agent_name(None)
    assert excinfo.value.code == 1


def test_resolve_agent_name_echoes_error_message(monkeypatch, capsys):
    monkeypatch.setattr(_agent_common, "_agent_name_from_cwd", lambda: None)
    with pytest.raises(SystemExit):
        _agent_common.resolve_agent_name(None)
    captured = capsys.readouterr()
    assert "no agent name given and no agent config" in captured.out


# ---------------------------------------------------------------------------
# infer_locale
# ---------------------------------------------------------------------------

def test_infer_locale_returns_backend_lang(monkeypatch):
    monkeypatch.setattr(_agent_common.api, "get", lambda path: {"lang": "es-MX"})
    assert _agent_common.infer_locale("Paulina") == "es-MX"


def test_infer_locale_defaults_to_en_us_on_backend_failure(monkeypatch):
    def fake_get(path):
        raise RuntimeError("backend unreachable")

    monkeypatch.setattr(_agent_common.api, "get", fake_get)
    assert _agent_common.infer_locale("Samantha") == "en-US"


def test_infer_locale_defaults_to_en_us_when_lang_missing(monkeypatch):
    monkeypatch.setattr(_agent_common.api, "get", lambda path: {})
    assert _agent_common.infer_locale("Samantha") == "en-US"


# ---------------------------------------------------------------------------
# OSError wrapping in `agent new` / `agent restore`
# ---------------------------------------------------------------------------

def test_agent_new_reports_clear_error_on_write_failure(monkeypatch, tmp_path):
    """If writing .las-agent.json raises OSError, `agent new` must exit(1) with a clear message."""
    monkeypatch.setattr(agents_mod.api, "get", lambda path: {"voice": "Samantha"})

    def boom(self, *a, **kw):
        raise OSError("disk full")

    monkeypatch.setattr("pathlib.Path.write_text", boom)

    runner = CliRunner()
    result = runner.invoke(
        agents_mod.new,
        ["testagent", "--voice", "Samantha", "--dir", str(tmp_path / "agentdir")],
    )

    assert result.exit_code != 0
    assert "could not write" in result.output
    assert "disk full" in result.output


def test_agent_restore_reports_clear_error_on_write_failure(monkeypatch, tmp_path):
    """If writing .las-agent.json raises OSError, `agent restore` must exit(1) with a clear message."""
    monkeypatch.setattr(
        agents_mod.api,
        "get",
        lambda path: {"someagent": {"voice": "Samantha", "path": str(tmp_path), "locale": "en-US"}},
    )
    monkeypatch.chdir(tmp_path)

    def boom(self, *a, **kw):
        raise OSError("permission denied")

    monkeypatch.setattr("pathlib.Path.write_text", boom)

    runner = CliRunner()
    result = runner.invoke(agents_mod.restore, ["someagent"])

    assert result.exit_code != 0
    assert "could not write" in result.output
    assert "permission denied" in result.output
