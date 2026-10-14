#!/bin/bash
# Restarts the backend + widget-electron app, but first checks whether a
# mic dictation is actually in progress (by tailing session/widget.log) and
# only plays the 3 warning beeps when it genuinely is — never "just in
# case". Anyone (a person or an agent) can run this directly; it needs no
# LLM reasoning to decide whether to warn.
SYSTEM_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
WIDGET_LOG="$SYSTEM_DIR/session/widget.log"

is_mic_recording() {
    [ -f "$WIDGET_LOG" ] || return 1
    # Last [mic] line across every window. If it's "recording started" with
    # no later stop/self-test/transcribe line after it, a dictation is
    # currently in flight.
    last_mic_line=$(grep '\[mic\]' "$WIDGET_LOG" | tail -1)
    [[ "$last_mic_line" == *"recording started"* ]]
}

if is_mic_recording; then
    echo "restart-widget: mic is mid-recording — warning before restart"
    for _ in 1 2 3; do
        afplay /System/Library/Sounds/Ping.aiff
        sleep 1
    done
else
    echo "restart-widget: mic idle — restarting without warning"
fi

# stop.sh / start.sh go through backend/service.sh: under launchd the
# backend is restarted by launchctl, never re-spawned as a manual process.
"$SYSTEM_DIR/stop.sh"
sleep 2
"$SYSTEM_DIR/start.sh"
