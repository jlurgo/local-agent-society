#!/bin/bash
SYSTEM_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# ── backend ───────────────────────────────────────────────────────────────────
# Through launchd when the LaunchAgent is installed (backend/service.sh,
# docs/adr/0002): a plain kill of a KeepAlive job either comes straight back
# or, on a clean exit, leaves launchd and the port out of step.
bash "$SYSTEM_DIR/backend/service.sh" stop

# ── widget (Electron) ────────────────────────────────────────────────────────
# Covers both the packaged app (process name matches the productName, "Local
# Agent Society") and a dev instance launched via `npm start`/`electron .`
# under widget-electron/ (process name "Electron", cwd under widget-electron).
#
# Waits for the processes to actually exit before returning: a caller like
# update.sh runs electron-builder right after this to overwrite
# dist/mac-arm64/Local Agent Society.app, and `kill` alone only sends SIGTERM
# without waiting — helper processes (renderer/GPU) can still be shutting
# down and holding file handles into the bundle when the rebuild starts,
# corrupting the freshly-built .app so it silently fails to launch.
FOUND=0
WIDGET_PATTERN='Local Agent Society\.app/Contents/MacOS/Local Agent Society|widget-electron'
PIDS=$(pgrep -f "$WIDGET_PATTERN" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
    FOUND=1
    kill $PIDS 2>/dev/null
    for _ in $(seq 1 20); do
        PIDS=$(pgrep -f "$WIDGET_PATTERN" 2>/dev/null || true)
        [ -z "$PIDS" ] && break
        sleep 0.25
    done
    if [ -n "$PIDS" ]; then
        kill -9 $PIDS 2>/dev/null
        sleep 0.25
    fi
fi

if [ "$FOUND" -eq 1 ]; then
    echo "Society    → stopped"
else
    echo "Society    → not running"
fi
