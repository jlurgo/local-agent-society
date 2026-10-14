#!/bin/bash
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PID_FILE="$SCRIPT_DIR/backend.pid"

# Under launchd (the LaunchAgent install.sh writes) the backend must never be
# started or stopped by hand — a manual process pre-empts the supervised one
# (docs/adr/0002). Without --manual this script hands over to service.sh,
# which talks to launchctl; service.sh itself calls back with --manual only
# where there is no LaunchAgent.
if [ "${1:-}" != "--manual" ] && [ -f "${LAS_BACKEND_PLIST:-$HOME/Library/LaunchAgents/com.localagent.system.plist}" ]; then
    exec bash "$SCRIPT_DIR/service.sh" stop
fi

if [ ! -f "$PID_FILE" ]; then
    echo "Backend not running (no PID file)"
    exit 0
fi

PID=$(cat "$PID_FILE")
if kill "$PID" 2>/dev/null; then
    echo "Backend stopped (PID $PID)"
    rm "$PID_FILE"
else
    echo "Process $PID not found — cleaning up"
    rm "$PID_FILE"
fi
