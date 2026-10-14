"""The /las-agent skill is what every session loads at start, so it is where
delivery noise is decided. Until 2026-09-27 the skill armed `las agent
listen` under Claude Code's Monitor tool, whose 30-minute cap produced a
visible re-arm turn every half hour in every session — the flooding the
LAS channel (docs/adr/0004) exists to remove. These tests pin the new
contract, in the copy install.sh ships (.claude/skills/las-agent/SKILL.md
must equal ~/.claude/skills/las-agent/SKILL.md after install)."""
from pathlib import Path

SKILL = (Path(__file__).parent.parent / ".claude/skills/las-agent/SKILL.md").read_text()


def _section(title: str) -> str:
    start = SKILL.index(title)
    end = SKILL.find("\n### ", start + 1)
    return SKILL[start:end if end != -1 else None]


def test_no_monitor_based_listener_remains_anywhere_in_the_skill():
    assert "Monitor(" not in SKILL
    assert "timeout_ms" not in SKILL
    assert "### Live listening" not in SKILL
    assert 'pkill -f "las agent listen' not in SKILL


def test_session_start_is_one_check_and_register_plus_poll_are_the_fallback_only():
    live = _section("### Presence and live delivery")
    register_cmd = "las agent register            # presence"   # the fallback code block, not the prose that forbids it at start
    assert live.index("las bridge status") < live.index(register_cmd)
    assert live.index(register_cmd) < live.index("las agent poll --timeout 2")
    assert "exits non-zero" in live and "by hand" in live
    assert "tell the user in one line that live delivery isn't active" in live


def test_one_command_per_runtime_is_the_documented_way_to_open_a_session():
    live = _section("### Presence and live delivery")
    for cmd in ("las claude", "las codex", "las shell"):
        assert cmd in live
    assert "chains" in live and "hands the terminal over" in live
    assert "no `las widget`, no `las agent register`, no alias" in live


def test_channel_event_shape_and_reply_path_are_documented():
    live = _section("### Presence and live delivery")
    assert '<channel source="las"' in live
    assert 'sender="' in live and 'origin="' in live and 'kind="' in live
    assert "`reply` tool" in live
    assert "las claude" in live and "--dangerously-load-development-channels server:las" in live


def test_probe_is_acked_silently_and_gates_mailbox_consumption():
    live = _section("### Presence and live delivery")
    assert "las_channel_ack" in live
    assert "[las-channel-probe]" in live
    assert "say nothing about it" in live
    assert "only then does the bridge attach the mailbox" in live


def test_listen_under_a_monitor_is_explicitly_forbidden_and_non_claude_runtimes_are_named():
    live = _section("### Presence and live delivery")
    assert "Never start `las agent listen` under a Monitor" in live
    for runtime in ("las bridge shell", "las bridge exec", "las bridge stdout"):
        assert runtime in live


def test_closing_report_is_skipped_on_housekeeping_turns_including_probes():
    report = _section("### Closing report")
    assert "Not on housekeeping turns" in report
    assert "a channel probe" in report
    assert "no closing report and no TTS at all" in report


def test_installed_copy_matches_the_repo_copy_when_present():
    installed = Path.home() / ".claude/skills/las-agent/SKILL.md"
    if installed.exists():
        assert installed.read_text() == SKILL, "run install.sh (or copy) — the shipped skill drifted from the repo"


def test_skill_tells_sessions_to_title_themselves_and_answer_a_title_request_silently():
    assert 'las agent title' in SKILL
    assert 'kind="title-request"' in SKILL
    assert 'no reply, no TTS, no closing report' in SKILL


def test_skill_names_how_each_runtime_finds_its_own_session_and_owns_the_window_title():
    """2026-10-14: `las agent title` failed inside Codex (its daemon runs the commands) and the
    window still showed Codex's own title. The skill must say why per runtime, not hand-wave."""
    assert "app-server daemon" in SKILL and "working directory" in SKILL
    assert "CLAUDECODE" in SKILL
    assert "CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1" in SKILL and "tui.terminal_title=[]" in SKILL
    assert "LAS_TERMINAL_TITLE=0" in SKILL
    assert "case and punctuation don't count" in SKILL


def test_skill_teaches_the_society_map_and_the_recipient_note():
    assert "las agent sessions --all" in SKILL
    assert "--refresh" in SKILL
    assert "Answering as the recipient" in SKILL
