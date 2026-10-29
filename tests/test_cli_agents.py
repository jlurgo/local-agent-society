"""
Regression test for the "swallowed SystemExit" bug in cli/commands/agents.py.

`cli.api.get`/`post`/etc. print an error and `sys.exit(1)` (raising SystemExit)
when the backend is unreachable or returns an HTTP error. `agent new` used to
catch that SystemExit around the locale lookup and silently fall back to
"en-US", so the command reported success (exit code 0) even though the
backend call actually failed. This test asserts the failure now propagates.
"""
import json
import sys
import types

from click.testing import CliRunner

from cli.commands import agents as agents_mod
from cli import api as api_mod


def test_agent_new_propagates_backend_failure(monkeypatch, tmp_path):
    """`las agent new` must exit non-zero if the backend locale lookup fails."""

    def fake_get(path):
        # Simulate cli.api.get's real behavior on a backend/HTTP error:
        # it prints an error and calls sys.exit(1), raising SystemExit.
        print("Error: backend not running. Try `las start`.")
        raise SystemExit(1)

    monkeypatch.setattr(api_mod, "get", fake_get)
    monkeypatch.setattr(agents_mod.api, "get", fake_get)

    runner = CliRunner()
    result = runner.invoke(
        agents_mod.new,
        ["testagent", "--voice", "Samantha", "--dir", str(tmp_path / "agentdir")],
    )

    # The command must NOT silently succeed with a fallback locale.
    assert result.exit_code != 0
    assert isinstance(result.exception, SystemExit)

    # It must not have gotten far enough to write a bogus .las-agent.json either.
    assert not (tmp_path / "agentdir" / ".las-agent.json").exists()


def test_widgets_all_skips_inactive_agents(monkeypatch):
    """`las widgets` is a bulk/auto reopen — an inactive agent must stay put
    away unless deliberately reactivated (`las widget NAME`, `las agent
    activate`, or the vortexia wake-enabled fallback), none of which go
    through this command."""
    monkeypatch.setattr(
        agents_mod.api,
        "get",
        lambda path: {
            "Active1": {"inactive": False},
            "Inactive1": {"inactive": True},
            "Active2": {},  # no "inactive" key at all -> must still open
        },
    )
    opened = []
    monkeypatch.setattr(
        agents_mod.subprocess, "run", lambda cmd, **kw: opened.append(cmd[-1])
    )

    runner = CliRunner()
    result = runner.invoke(agents_mod.widgets_all)

    assert result.exit_code == 0
    assert any("Active1" in url for url in opened)
    assert any("Active2" in url for url in opened)
    assert not any("Inactive1" in url for url in opened)


class _FakeClock:
    """Lets a test drive `widget`'s 5s poll loop without any real wall-clock
    wait: time.sleep() advances the fake clock instead of actually sleeping,
    so a loop that "waits" 5 seconds in the code executes instantly here."""

    def __init__(self):
        self.now = 0.0

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def test_widget_reports_success_once_process_is_found(monkeypatch):
    """`las widget` must confirm the app actually launched — not just that
    `open` was fired — before printing "Widget reopened". If pgrep finds the
    packaged app process on the very first check, it must report success
    immediately (no unnecessary polling/sleeping)."""
    monkeypatch.setattr(agents_mod, "resolve_agent_name", lambda name: name or "TestAgent")

    clock = _FakeClock()
    monkeypatch.setattr(agents_mod.time, "time", clock.time)
    monkeypatch.setattr(agents_mod.time, "sleep", clock.sleep)

    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        if cmd[0] == "pgrep":
            return types.SimpleNamespace(returncode=0)
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(agents_mod.subprocess, "run", fake_run)

    runner = CliRunner()
    result = runner.invoke(agents_mod.widget, ["TestAgent"])

    assert result.exit_code == 0
    assert "Widget reopened for TestAgent." in result.output
    assert "may have failed to launch" not in result.output
    # Exactly one pgrep check — found on the first try, so no polling delay.
    assert sum(1 for c in calls if c[0] == "pgrep") == 1
    assert clock.now == 0.0


def test_widget_reports_failure_when_process_never_appears(monkeypatch):
    """If `open` routes the reopen request but the packaged app never
    actually starts (e.g. a corrupted dist/ build from the electron-builder
    rebuild race), `las widget` must say so instead of unconditionally
    claiming success — this is what hid the widget-electron launch bug from
    the reporter for two days."""
    monkeypatch.setattr(agents_mod, "resolve_agent_name", lambda name: name or "TestAgent")

    clock = _FakeClock()
    monkeypatch.setattr(agents_mod.time, "time", clock.time)
    monkeypatch.setattr(agents_mod.time, "sleep", clock.sleep)

    def fake_run(cmd, **kwargs):
        if cmd[0] == "pgrep":
            return types.SimpleNamespace(returncode=1)  # never found
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(agents_mod.subprocess, "run", fake_run)

    runner = CliRunner()
    result = runner.invoke(agents_mod.widget, ["TestAgent"])

    assert result.exit_code == 0  # fails soft — a message, not a crash
    assert "Widget reopened for TestAgent." not in result.output
    assert "no running process was found after 5s" in result.output
    assert "may have failed to launch" in result.output
    # Polled for the full 5s window before giving up.
    assert clock.now >= 5.0


def test_agent_listen_exits_cleanly_when_vortexia_unreachable(monkeypatch):
    """`las agent listen` must fail soft (clear message, exit 1) — not hang or
    crash — when it can't find a vortexia-mqtt port in the registry. This is
    the live-delivery counterpart to `las agent poll`: it's meant to be run
    under Claude Code's Monitor tool (see .claude/skills/las-agent/SKILL.md),
    so a hang here would hang the whole session-start flow instead of just
    reporting "no live delivery available" and moving on.
    """
    monkeypatch.setattr(agents_mod.api, "get", lambda path: {})  # no vortexia-mqtt entry
    # ...and no live broker's vortexia.port.json either (on a dev machine the
    # sibling ../vortexia checkout has one, and `listen` would rightly connect
    # to it — see vortexia_client.resolve_mqtt_port).
    import vortexia_client as vx
    monkeypatch.setattr(vx, "default_port_file_candidates", lambda ports=None: [])

    runner = CliRunner()
    result = runner.invoke(agents_mod.listen, ["testagent"])

    assert result.exit_code != 0
    assert "vortexia unreachable" in result.output.lower()


def test_agent_listen_mechanically_and_silently_answers_the_mic_selftest_ping_without_any_llm(monkeypatch):
    """`las agent listen` must answer the mic self-test sentinel the instant
    it arrives, entirely on its own, with a SILENT direct MQTT pong — never
    /queue/speak (that would make plumbing-only confirmation sound like a
    real LLM reply, since /queue/speak is audible). This is what lets the
    widget's double-click self-test confirm the mic -> vortexia -> a live
    terminal-side listener pipe is intact without depending on whether an
    LLM session is attached and chooses to react (see widget.js's
    MIC_SELFTEST_PING / runMicSelfTest / the 'mic-selftest-pong' kind check,
    and this command's docstring).
    """
    MIC_SELFTEST_PING = '[las-mic-selftest] reply with just "OK" to confirm this session is listening.'

    def fake_get(path):
        if path == "/ports":
            return {"9012": {"app": "vortexia-mqtt", "port": 9012, "registered_at": "2026-01-01T00:00:00"}}
        return {}

    monkeypatch.setattr(agents_mod.api, "get", fake_get)

    posted = []
    monkeypatch.setattr(agents_mod.api, "post", lambda path, payload: posted.append((path, payload)))

    class FakeMessage:
        def __init__(self, text):
            self.payload = json.dumps({"from": "testagent", "to": "testagent", "text": text}).encode()

    created_clients = []

    class FakeMQTTClient:
        def __init__(self, *a, **k):
            self.on_connect = None
            self.on_message = None
            self.published = []
            created_clients.append(self)

        def subscribe(self, *a, **k):
            pass

        def publish(self, *a, payload=None, **k):
            self.published.append({"args": a, "payload": payload, "kwargs": k})

        def connect(self, *a, **k):
            pass

        def loop_forever(self):
            # Simulate one real dictation (must NOT trigger any pong) and
            # one self-test ping (must trigger exactly one silent pong).
            self.on_message(self, None, FakeMessage("hola, alguien ahí?"))
            self.on_message(self, None, FakeMessage(MIC_SELFTEST_PING))

    # Fake out the whole paho.mqtt.client chain, parent packages included —
    # vortexia_client.py (imported by `listen`) does its own top-level
    # `import paho.mqtt.client`, which needs "paho" and "paho.mqtt" present
    # in sys.modules too, not just the leaf submodule, or Python's import
    # machinery raises ModuleNotFoundError before ever reaching our fake.
    fake_paho_client_module = types.SimpleNamespace(
        Client=FakeMQTTClient,
        MQTTv311="MQTTv311",
    )
    fake_paho_mqtt_pkg = types.ModuleType("paho.mqtt")
    fake_paho_mqtt_pkg.client = fake_paho_client_module
    fake_paho_pkg = types.ModuleType("paho")
    fake_paho_pkg.mqtt = fake_paho_mqtt_pkg
    monkeypatch.setitem(sys.modules, "paho", fake_paho_pkg)
    monkeypatch.setitem(sys.modules, "paho.mqtt", fake_paho_mqtt_pkg)
    monkeypatch.setitem(sys.modules, "paho.mqtt.client", fake_paho_client_module)

    runner = CliRunner()
    result = runner.invoke(agents_mod.listen, ["testagent"])

    assert result.exit_code == 0
    # Never speaks the mechanical confirmation out loud.
    assert not [p for p in posted if p[0] == "/queue/speak"]

    # Inspect what got published on the MQTT topic: exactly one pong, not
    # retained, carrying kind "mic-selftest-pong".
    pongs = []
    for call in created_clients[-1].published:
        payload = call["payload"]
        if not payload:
            continue
        envelope = json.loads(payload)
        if envelope.get("kind") == "mic-selftest-pong":
            pongs.append((envelope, call["kwargs"]))

    assert len(pongs) == 1, f"expected exactly one silent pong, got {pongs}"
    envelope, kwargs = pongs[0]
    assert envelope["to"] == "testagent"
    assert envelope["text"] == "OK"
    assert kwargs.get("retain") is False

    # Mailbox model: the listener never clears a retained slot (an empty
    # retained publish) — every publish it makes carries a real payload.
    assert all(call["payload"] for call in created_clients[-1].published), created_clients[-1].published


def test_agent_new_is_what_writes_las_agent_json(monkeypatch, tmp_path):
    """install.sh no longer creates any .las-agent.json (d044934): creating an
    agent is the one place the file comes from, so `las agent new` must write it."""
    posts = []
    monkeypatch.setattr(agents_mod.api, "post", lambda path, data=None: posts.append(path) or {})
    monkeypatch.setattr(agents_mod.subprocess, "run", lambda *a, **k: None)

    result = CliRunner().invoke(agents_mod.new, ["Fresh", "--voice", "Paulina", "--dir", str(tmp_path / "fresh")])

    assert result.exit_code == 0, result.output
    config = json.loads((tmp_path / "fresh" / ".las-agent.json").read_text())
    assert config["name"] == "Fresh" and config["voice"] == "Paulina"
    assert "/agents" in posts
