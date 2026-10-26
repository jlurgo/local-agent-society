#!/bin/bash
# Foreground runner for launchd (KeepAlive). Do not use for manual dev starts — use start.sh.
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PORT=8700
mkdir -p "$SCRIPT_DIR/logs"

VENV="$SCRIPT_DIR/.venv"
source "$SCRIPT_DIR/venv.sh"
ensure_backend_venv "$VENV" "$SCRIPT_DIR/requirements.txt"

cd "$SCRIPT_DIR"
# main.py imports cli.path_utils at module level — needs the repo root on
# PYTHONPATH, same as start.sh sets for manual runs. Without this, every
# launchd-triggered start crashed on import and the job never stayed up
# (silently crash-looping under launchd's KeepAlive/ThrottleInterval).
export PYTHONPATH="$SCRIPT_DIR/.."
# VORTEXIA_ENV_NAME (this machine's federation identity — see
# backend/main.py's inject_message federation fallback) is deliberately
# NOT set here: this script is a checked-in file shared by every clone of
# this repo, so a hardcoded value here travels to every machine on the
# next `git pull` — bit us for real (a second Mac inherited "ba-mac" from
# this file verbatim, colliding with its own identity). It must come from
# this machine's own launchd plist (~/Library/LaunchAgents/
# com.localagent.system.plist's EnvironmentVariables — outside git, same
# place vortexia's own env name/Gist/Nostr config lives) or the calling
# shell's environment for a manual run; if neither sets it, federation is
# simply off for this run, same as vortexia's own opt-in behavior.
exec "$VENV/bin/python" -m uvicorn main:app --host 0.0.0.0 --port $PORT
