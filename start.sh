#!/bin/bash
SYSTEM_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# ── backend ───────────────────────────────────────────────────────────────────
# Through launchd when the LaunchAgent is installed, never a manual process
# next to it (backend/service.sh, docs/adr/0002).
bash "$SYSTEM_DIR/backend/service.sh" start

# ── Local Agent Society widget (Electron) ───────────────────────────────────────
# Canonical packaged app is "Local Agent Society.app", built by
# `widget-electron`'s electron-builder config (see install.sh step 1a).
# Only ONE widget process family may run at a time — historically two tray
# binaries running together caused every agent widget to open twice on
# different Spaces (tests/test_widget_reopen.py). Guard against that here
# for both the packaged app and a `npm start` dev instance.
WIDGET_DIR="$SYSTEM_DIR/widget-electron"
WIDGET_APP="$WIDGET_DIR/dist/mac-arm64/Local Agent Society.app"
if [ ! -d "$WIDGET_APP" ]; then
    WIDGET_APP="$WIDGET_DIR/dist/mac/Local Agent Society.app"
fi

if pgrep -f "Local Agent Society.app/Contents/MacOS/Local Agent Society" > /dev/null 2>&1 \
   || pgrep -f "widget-electron" > /dev/null 2>&1; then
    echo "Society    → already running"
else
    if [ ! -d "$WIDGET_APP" ]; then
        echo "Society    → widget not built yet, building..."
        (cd "$WIDGET_DIR" && npm install --no-audit --no-fund -q && npm run build -q)
        WIDGET_APP="$WIDGET_DIR/dist/mac-arm64/Local Agent Society.app"
        if [ ! -d "$WIDGET_APP" ]; then
            WIDGET_APP="$WIDGET_DIR/dist/mac/Local Agent Society.app"
        fi
    fi
    if [ -d "$WIDGET_APP" ]; then
        open "$WIDGET_APP"
        echo "Society    → launched"
    else
        echo "Society    → ⚠️  could not find or build widget-electron .app bundle"
    fi
fi

echo ""
echo "Ready. Open Claude Code in any directory with .las-agent.json."
