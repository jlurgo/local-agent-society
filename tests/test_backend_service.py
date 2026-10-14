"""backend/service.sh — the one way to start/stop/restart the backend.

Twice (2026-09-14, 2026-09-28) the live backend turned out to be a MANUAL
process (backend/start.sh, run by start.sh / restart-widget.sh) squatting
:8700 while the launchd job died hundreds of times on "address already in
use". These tests drive service.sh against a fake `launchctl` (a script that
keeps the job's loaded/pid state in a temp dir and really listens on the
port) and a real stray listener, so what is checked is the shipped script's
behaviour: launchd is always the one running it, a stray is removed first,
and nothing in the top-level scripts starts a manual backend anymore."""
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
SERVICE = REPO / "backend" / "service.sh"

FAKE_LAUNCHCTL = r"""#!/bin/bash
S="$FAKE_LAUNCHD_STATE"
echo "$*" >> "$S/calls"
listen() {
    nohup "$FAKE_PYTHON" -c "import socket,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', $LAS_BACKEND_PORT)); s.listen(); time.sleep(60)" > /dev/null 2>&1 &
    echo $! > "$S/pid"
}
stop_job() { [ -f "$S/pid" ] && kill "$(cat "$S/pid")" 2>/dev/null; rm -f "$S/pid"; sleep 0.3; }
case "$1" in
    print)
        [ -f "$S/loaded" ] || exit 113
        echo "com.localagent.system = {"
        [ -f "$S/pid" ] && printf '\tpid = %s\n' "$(cat "$S/pid")"
        echo "}" ;;
    bootstrap) touch "$S/loaded"; listen ;;
    kickstart) [ "$2" = "-k" ] && stop_job; listen ;;
    bootout) stop_job; rm -f "$S/loaded" ;;
esac
"""


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def launchd(tmp_path):
    state = tmp_path / "state"
    state.mkdir()
    fake = tmp_path / "launchctl"
    fake.write_text(FAKE_LAUNCHCTL)
    fake.chmod(0o755)
    plist = tmp_path / "com.localagent.system.plist"
    plist.write_text("<plist/>")
    env = {
        **os.environ,
        "LAS_LAUNCHCTL": str(fake),
        "LAS_BACKEND_PLIST": str(plist),
        "LAS_BACKEND_PORT": str(_free_port()),
        "FAKE_LAUNCHD_STATE": str(state),
        "FAKE_PYTHON": sys.executable,
    }

    def run(*args):
        return subprocess.run(["bash", str(SERVICE), *args], env=env, capture_output=True, text=True, timeout=30)

    def calls():
        path = state / "calls"
        return [line.split()[0] for line in path.read_text().splitlines()] if path.exists() else []

    run.env, run.state, run.calls, run.plist = env, state, calls, plist
    yield run
    pid_file = state / "pid"
    if pid_file.exists():
        try:
            os.kill(int(pid_file.read_text()), signal.SIGTERM)
        except (OSError, ValueError):
            pass


def _stray(port: int) -> subprocess.Popen:
    """A backend someone started by hand: listens on the port, not launchd's."""
    proc = subprocess.Popen([sys.executable, "-c", f"""import socket,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', {port})); s.listen(); time.sleep(60)"""])
    for _ in range(40):
        if subprocess.run(["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"], capture_output=True).stdout.strip():
            break
        time.sleep(0.1)
    return proc


def test_start_bootstraps_the_launchd_job_and_reports_its_pid(launchd):
    result = launchd("start")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "running under launchd" in result.stdout
    assert "bootstrap" in launchd.calls()
    again = launchd("start")
    assert again.returncode == 0
    assert launchd.calls().count("bootstrap") == 1, "already loaded and running: nothing to do"


def test_start_removes_a_stray_manual_backend_before_launchd_takes_the_port(launchd):
    stray = _stray(int(launchd.env["LAS_BACKEND_PORT"]))
    try:
        result = launchd("start")
        assert result.returncode == 0, result.stdout + result.stderr
        assert "removed a stray manual backend" in result.stdout
        assert stray.wait(timeout=5) is not None, "the stray must be gone"
        assert "running under launchd" in result.stdout
    finally:
        if stray.poll() is None:
            stray.kill()


def test_stop_unloads_the_job_and_restart_kickstarts_it(launchd):
    launchd("start")
    stopped = launchd("stop")
    assert "stopped" in stopped.stdout
    assert "bootout" in launchd.calls()
    assert launchd("status").returncode == 1
    restarted = launchd("restart")
    assert restarted.returncode == 0, restarted.stdout + restarted.stderr
    assert launchd.calls().count("bootstrap") == 2, "restart of an unloaded job loads it again"
    assert launchd("status").returncode == 0
    launchd("restart")
    assert "kickstart" in launchd.calls(), "restart of a loaded job is kickstart -k"


def test_backend_start_sh_by_hand_hands_over_to_launchd(launchd):
    """The old trap itself: someone runs backend/start.sh. With the LaunchAgent
    installed it must not spawn uvicorn — it goes through service.sh."""
    result = subprocess.run(["bash", str(REPO / "backend" / "start.sh")], env=launchd.env, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "running under launchd" in result.stdout
    assert "bootstrap" in launchd.calls()
    assert not (REPO / "backend" / "backend.pid").exists(), "no manual pid file left behind"


def test_top_level_scripts_never_start_a_manual_backend():
    for name in ("start.sh", "stop.sh", "restart-widget.sh", "update.sh"):
        src = (REPO / name).read_text()
        assert "backend/start.sh" not in src and "backend/stop.sh" not in src, f"{name} must go through backend/service.sh"
    assert 'backend/service.sh" start' in (REPO / "start.sh").read_text()
    assert 'backend/service.sh" stop' in (REPO / "stop.sh").read_text()
