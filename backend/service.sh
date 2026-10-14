#!/bin/bash
# The ONE way to start, stop or restart the backend (docs/adr/0002).
#
#   backend/service.sh start | stop | restart | status
#
# Where the per-user LaunchAgent is installed (install.sh writes
# ~/Library/LaunchAgents/com.localagent.system.plist), launchd owns the
# process and this script only talks to launchctl:
#   start    bootstrap the job if it isn't loaded, kickstart it if it is
#   stop     bootout — stays stopped until `start` or the next login
#   restart  kickstart -k — the running code is replaced, same supervision
# Before any of that it removes a STRAY backend: a process on the port that
# launchd did not start (someone ran the old backend/start.sh by hand). That
# stray pre-empted launchd twice (2026-09-14, 2026-09-28): it held :8700, the
# job died on "address already in use" hundreds of times, and the live
# backend was one nobody supervised. `backend.pid` existing is its tell.
#
# Without the LaunchAgent (not installed, or not macOS) it falls back to the
# manual mode backend/start.sh and backend/stop.sh implement.
#
# Overridable for tests: LAS_BACKEND_PLIST, LAS_BACKEND_PORT, LAS_LAUNCHCTL.
set -u
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
LABEL="com.localagent.system"
PLIST="${LAS_BACKEND_PLIST:-$HOME/Library/LaunchAgents/$LABEL.plist}"
PORT="${LAS_BACKEND_PORT:-8700}"
LAUNCHCTL="${LAS_LAUNCHCTL:-launchctl}"
DOMAIN="gui/$(id -u)"
PID_FILE="$SCRIPT_DIR/backend.pid"

managed() {
    [ -f "$PLIST" ] && command -v "$LAUNCHCTL" > /dev/null 2>&1
}

launchd_pid() {
    "$LAUNCHCTL" print "$DOMAIN/$LABEL" 2>/dev/null | awk '/^\tpid = / {print $3; exit}'
}

loaded() {
    "$LAUNCHCTL" print "$DOMAIN/$LABEL" > /dev/null 2>&1
}

# Kill whatever holds the port that launchd did not start.
remove_stray() {
    local job_pid holders pid
    job_pid="$(launchd_pid)"
    holders="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    for pid in $holders; do
        [ -n "$job_pid" ] && [ "$pid" = "$job_pid" ] && continue
        kill "$pid" 2>/dev/null && echo "Backend    → removed a stray manual backend (PID $pid) — launchd runs it now"
    done
    rm -f "$PID_FILE"
}

wait_for_port() {
    for _ in $(seq 1 40); do
        lsof -ti tcp:"$PORT" -sTCP:LISTEN > /dev/null 2>&1 && return 0
        sleep 0.25
    done
    return 1
}

report_up() {
    if wait_for_port; then
        echo "Backend    → running under launchd (PID $(launchd_pid)) → http://localhost:$PORT"
    else
        echo "Backend    → ⚠️  launchd job did not open :$PORT — see backend/logs/launchd.err.log"
        return 1
    fi
}

cmd="${1:-status}"

if ! managed; then
    case "$cmd" in
        start)   exec bash "$SCRIPT_DIR/start.sh" --manual ;;
        stop)    exec bash "$SCRIPT_DIR/stop.sh" --manual ;;
        restart) bash "$SCRIPT_DIR/stop.sh" --manual; exec bash "$SCRIPT_DIR/start.sh" --manual ;;
        status)
            if lsof -ti tcp:"$PORT" -sTCP:LISTEN > /dev/null 2>&1; then echo "Backend    → running (manual, no LaunchAgent)"; else echo "Backend    → not running"; exit 1; fi ;;
        *) echo "usage: $0 start|stop|restart|status" >&2; exit 64 ;;
    esac
    exit 0
fi

case "$cmd" in
    start)
        remove_stray
        if ! loaded; then
            "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"
        elif [ -z "$(launchd_pid)" ]; then
            "$LAUNCHCTL" kickstart "$DOMAIN/$LABEL"
        fi
        report_up
        ;;
    stop)
        remove_stray
        if loaded; then
            "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" 2>/dev/null
            echo "Backend    → stopped (launchd job unloaded until \`las start\` or next login)"
        else
            echo "Backend    → not running"
        fi
        ;;
    restart)
        remove_stray
        if loaded; then
            "$LAUNCHCTL" kickstart -k "$DOMAIN/$LABEL"
        else
            "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"
        fi
        report_up
        ;;
    status)
        if [ -n "$(launchd_pid)" ]; then
            echo "Backend    → running under launchd (PID $(launchd_pid))"
        else
            echo "Backend    → not running (launchd job $(loaded && echo loaded || echo unloaded))"
            exit 1
        fi
        ;;
    *) echo "usage: $0 start|stop|restart|status" >&2; exit 64 ;;
esac
