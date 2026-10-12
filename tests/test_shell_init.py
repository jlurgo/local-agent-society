"""`las shell-init` — terminal tint snippet and its idempotent ~/.zshrc line."""
import json
import shutil
import subprocess

import pytest
from click.testing import CliRunner

from cli.commands import shell_init as si


def test_install_adds_one_source_line_and_is_idempotent(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / ".zshrc").write_text("export FOO=1\n")
    runner = CliRunner()
    for _ in range(2):
        assert runner.invoke(si.shell_init, ["--install"]).exit_code == 0
    lines = (tmp_path / ".zshrc").read_text().splitlines()
    assert lines[0] == "export FOO=1"
    assert sum(l.endswith(si.MARKER) for l in lines) == 1


def test_print_mode_emits_the_snippet():
    out = CliRunner().invoke(si.shell_init, []).output
    assert "_las_bg_update" in out and "add-zsh-hook chpwd" in out


def _run(tmp_path, cwd, **env):
    full = {"HOME": str(tmp_path), "PATH": "/usr/bin:/bin:/opt/homebrew/bin", "TERM_PROGRAM": "ghostty", **env}
    return subprocess.run(["zsh", "-f", "-c", f"source {si.SNIPPET}"], cwd=cwd, env=full,
                          capture_output=True).stdout


@pytest.mark.skipif(not (shutil.which("zsh") and shutil.which("jq")), reason="needs zsh + jq")
def test_agent_folder_tints_and_other_folders_reset(tmp_path):
    agent = tmp_path / "proj"
    (agent / "sub").mkdir(parents=True)
    (agent / ".las-agent.json").write_text(json.dumps({"name": "Demo"}))
    prefs = tmp_path / "Library/Application Support/widget-electron"
    prefs.mkdir(parents=True)
    (prefs / "widget-electron-prefs.json").write_text(json.dumps({"agents": {"Demo": {"color": "#ff0000"}}}))
    # 15% mix over 101010: ff -> 0x33, 00 -> 0x0e
    assert _run(tmp_path, agent / "sub") == b"\x1b]11;#330e0e\x07"
    assert _run(tmp_path, tmp_path) == b"\x1b]111\x07"
    assert _run(tmp_path, agent, LAS_TINT="0") == b""
    assert _run(tmp_path, agent, TERM_PROGRAM="Apple_Terminal") == b""
    assert _run(tmp_path, agent, TMUX="x").startswith(b"\x1bPtmux;")
