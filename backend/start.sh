#!/bin/bash
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PID_FILE="$SCRIPT_DIR/backend.pid"

# Under launchd (the LaunchAgent install.sh writes) the backend must never be
# started or stopped by hand — a manual process pre-empts the supervised one
# (docs/adr/0002). Without --manual this script hands over to service.sh,
# which talks to launchctl; service.sh itself calls back with --manual only
# where there is no LaunchAgent.
if [ "${1:-}" != "--manual" ] && [ -f "${LAS_BACKEND_PLIST:-$HOME/Library/LaunchAgents/com.localagent.system.plist}" ]; then
    exec bash "$SCRIPT_DIR/service.sh" start
fi
mkdir -p "$SCRIPT_DIR/logs"
# App-level diagnostics (e.g. vortexia connection issues) go through
# logging_config.py into logs/backend.log with daily rotation, 7-day
# retention. This raw stdout/stderr capture is only for output emitted
# before that's initialized, or a hard crash on the way down.
LOG_FILE="$SCRIPT_DIR/logs/launchd.out.log"
PORT=8700

if lsof -ti tcp:$PORT > /dev/null 2>&1; then
    echo "Backend already running on http://localhost:$PORT"
    exit 0
fi

if [ -f "$PID_FILE" ]; then
    rm "$PID_FILE"
fi

VENV="$SCRIPT_DIR/.venv"
source "$SCRIPT_DIR/venv.sh"
ensure_backend_venv "$VENV" "$SCRIPT_DIR/requirements.txt"

cd "$SCRIPT_DIR"
# VORTEXIA_ENV_NAME intentionally not set here — see serve.sh's comment.
# This is a checked-in, shared-across-clones file; hardcoding a per-machine
# value here is exactly the bug that shipped "ba-mac" to a second Mac via
# `git pull`. Federation is simply off for a manual `start.sh` run unless
# the calling shell already has VORTEXIA_ENV_NAME exported.
PYTHONPATH="$SCRIPT_DIR/.." nohup "$VENV/bin/python" -m uvicorn main:app --host 0.0.0.0 --port $PORT > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 2

if kill -0 $(cat "$PID_FILE") 2>/dev/null; then
    echo "Backend started → http://localhost:$PORT  (PID $(cat $PID_FILE))"
    echo "Docs          → http://localhost:$PORT/docs"
    echo "Log           → $LOG_FILE"
else
    echo "ERROR: backend failed to start. Last log lines:"
    tail -5 "$LOG_FILE" 2>/dev/null || echo "  (no log file)"
    rm "$PID_FILE"
    exit 1
fi
