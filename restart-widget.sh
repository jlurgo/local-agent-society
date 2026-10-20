#!/bin/bash
# Restarts the backend + widget-electron app — but never under a dictation:
# if a mic is recording right now (tailing session/widget.log), it plays the
# 3 warning beeps and WAITS for the recording to stop before restarting. A
# dictation may be impossible to repeat, so a restart must never cut one
# (2026-10-20). `--force` restarts anyway. The widget logs "[mic] idle" when
# it starts, so a recording a crash left unclosed can't block this forever.
# Anyone (a person or an agent) can run this directly; it needs no LLM
# reasoning to decide whether to wait.
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

if is_mic_recording && [ "$1" != "--force" ]; then
    echo "restart-widget: mic is mid-recording — waiting for the dictation to end (--force restarts anyway)"
    for _ in 1 2 3; do
        afplay /System/Library/Sounds/Ping.aiff
        sleep 1
    done
    while is_mic_recording; do sleep 2; done
    echo "restart-widget: dictation ended — restarting"
else
    echo "restart-widget: mic idle — restarting"
fi
# stop.sh / start.sh go through backend/service.sh: under launchd the
# backend is restarted by launchctl, never re-spawned as a manual process.
"$SYSTEM_DIR/stop.sh"
sleep 2
"$SYSTEM_DIR/start.sh"
