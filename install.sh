#!/bin/bash
# Local Agent Society — installer
# Usage: ./install.sh [AgentName]
# Default agent name: System
set -e

INSTALL_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
FAMILY="${1:-LocalAgentSociety}"

# ── 0. Node >= 22.12 ──────────────────────────────────────────────────────────
# Everything below runs node: the widget build (@electron/rebuild and node-abi
# need >=22.12), the bridge, and vortexia, whose launchd plist pins whichever
# `node` is first on PATH (vortexia/scripts/install-service.sh). Node 20 has no
# global WebSocket, so vortex-relay's Nostr transport fails every relay on it —
# on uy-mac an nvm v20 came first and every Name@env send went 404. Pick a
# recent node (Homebrew's arm64 first) and put it first on PATH for the rest.
node_ok() {
    "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' 2>/dev/null
}
NODE_BIN=""
for candidate in /opt/homebrew/bin/node "$(command -v node 2>/dev/null)" "$HOME"/.nvm/versions/node/v*/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ] && node_ok "$candidate"; then NODE_BIN="$candidate"; break; fi
done
if [ -z "$NODE_BIN" ]; then
    echo "ERROR: no Node >= 22.12 found (Homebrew, PATH, nvm). Install one — brew install node — and re-run." >&2
    exit 1
fi
export PATH="$( dirname "$NODE_BIN" ):$PATH"

echo "Local Agent Society — installing"
echo "  Directory : $INSTALL_DIR"
echo "  Agent     : $FAMILY"
echo "  Node      : $NODE_BIN ($("$NODE_BIN" --version))"
echo ""

# ── 1. Build the Electron widget app bundle ───────────────────────────────────
# (Replaces the old Swift tray.swift build — see swift-widget-final git tag
# for the retired native implementation.)
echo "[ 1/5 ] Building Electron widget..."
ELECTRON_DIR="$INSTALL_DIR/widget-electron"
# A previous build's dist/ can be left non-empty and locked (a widget still
# running from it) — electron-builder then dies with ENOTEMPTY. Start clean.
rm -rf "$ELECTRON_DIR/dist"
(cd "$ELECTRON_DIR" && npm install --no-audit --no-fund -q && npm run build -q)
ELECTRON_APP="$ELECTRON_DIR/dist/mac-arm64/Local Agent Society.app"
if [ ! -d "$ELECTRON_APP" ]; then
    # Intel build output path differs from Apple Silicon's.
    ELECTRON_APP="$ELECTRON_DIR/dist/mac/Local Agent Society.app"
fi
if [ -d "$ELECTRON_APP" ]; then
    echo "         built: $ELECTRON_APP"
else
    echo "         ⚠️  Electron widget build did not produce an .app bundle — check widget-electron/dist"
fi

# ── 1b. Bridge dependencies ──────────────────────────────────────────────────
# The bridge (bridge/, docs/adr/0004) delivers each agent's vortexia mailbox
# into its session: Claude Code starts it as the `las` MCP channel server,
# and `las bridge shell|exec|stdout` run it for anything that isn't Claude.
echo "[ 1b/5] Installing bridge dependencies..."
(cd "$INSTALL_DIR/bridge" && npm install --no-audit --no-fund -q)

# ── 2. Python dependencies ────────────────────────────────────────────────────
echo "[ 2/5 ] Installing Python dependencies..."
VENV="$INSTALL_DIR/backend/.venv"
source "$INSTALL_DIR/backend/venv.sh"
# requirements.txt, not a hand-picked subset — a fresh venv missing
# paho-mqtt crashes on `import vortexia_client` the moment the backend
# tries to talk to vortexia (found this bug the same way serve.sh had it,
# fixed there earlier; this was install.sh's own separate copy of it).
ensure_backend_venv "$VENV" "$INSTALL_DIR/backend/requirements.txt"

# ── 2b. Kokoro TTS model files ───────────────────────────────────────────────
# The backend synthesizes every widget voice with Kokoro-82M (see
# backend/main.py's TTS section). The model (~340MB) is gitignored, so a
# fresh clone has no voices at all until these two files exist — this used
# to be a manual curl documented only in a code comment. Idempotent: skips
# files already present.
echo "[ 2b/5] Fetching Kokoro TTS model (once, ~340MB)..."
KOKORO_DIR="$INSTALL_DIR/backend/data/kokoro"
KOKORO_BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
mkdir -p "$KOKORO_DIR"
for f in kokoro-v1.0.onnx voices-v1.0.bin; do
    if [ -s "$KOKORO_DIR/$f" ]; then
        echo "         present: $f"
    elif curl -fL --progress-bar -o "$KOKORO_DIR/$f.part" "$KOKORO_BASE/$f"; then
        mv "$KOKORO_DIR/$f.part" "$KOKORO_DIR/$f"
        echo "         downloaded: $f"
    else
        rm -f "$KOKORO_DIR/$f.part"
        echo "         ⚠️  could not download $f — TTS will fail until it exists (see backend/main.py)"
    fi
done

# ── 3. Install skills ─────────────────────────────────────────────────────────
echo "[ 3/5 ] Installing skills..."
for skill in local-agent-voice local-agent-pronunciation local-agent-widget; do
    mkdir -p ~/.claude/skills/$skill
    sed "s|INSTALL_DIR|$INSTALL_DIR|g" \
        "$INSTALL_DIR/skills/$skill/SKILL.md" \
        > ~/.claude/skills/$skill/SKILL.md
    echo "         skill: $skill"
done

# las-agent lives under .claude/skills (project-tracked) instead of skills/,
# since it doubles as this repo's own Claude Code skill.
mkdir -p ~/.claude/skills/las-agent
cp "$INSTALL_DIR/.claude/skills/las-agent/SKILL.md" ~/.claude/skills/las-agent/SKILL.md
echo "         skill: las-agent"

# ── 4. Update ~/.claude/settings.json ────────────────────────────────────────
# No Stop hook here anymore — the old one just spoke a fixed "Here! <Family>"
# with no real content. Reporting is now the las-agent skill's job: it
# instructs the model to speak an actual closing summary of what it did via
# `las speak`, so removing any stale Stop-hook entry from a previous install
# is part of this step too.
echo "[ 4/5 ] Updating Claude settings..."
python3 - <<PYEOF
import json, os

path = os.path.expanduser("~/.claude/settings.json")
with open(path) as f:
    s = json.load(f)

# permissions
perms = s.setdefault("permissions", {}).setdefault("allow", [])
for p in ["Bash(curl:*)", "Bash(python3:*)", "Bash(nohup:*)"]:
    if p not in perms:
        perms.append(p)

# Remove any leftover announce-here.sh Stop hook from a previous install.
stop = s.get("hooks", {}).get("Stop", [])
for entry in stop:
    entry["hooks"] = [h for h in entry.get("hooks", []) if "announce-here.sh" not in h.get("command", "")]
s.setdefault("hooks", {})["Stop"] = [e for e in stop if e.get("hooks")]
if not s["hooks"]["Stop"]:
    del s["hooks"]["Stop"]

with open(path, "w") as f:
    json.dump(s, f, indent=2)
print("         settings.json updated")
PYEOF

rm -f ~/.claude/hooks/announce-here.sh

# ── Initialize backend data ───────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR/backend/data"
for f in registry.json ports.json; do
    [ ! -f "$INSTALL_DIR/backend/data/$f" ] && echo '{}' > "$INSTALL_DIR/backend/data/$f"
done
[ ! -f "$INSTALL_DIR/backend/data/queue.json" ] && echo '[]' > "$INSTALL_DIR/backend/data/queue.json"
[ ! -f "$INSTALL_DIR/backend/data/attribution.json" ] && echo '[]' > "$INSTALL_DIR/backend/data/attribution.json"

# ── Purge legacy per-project watcher plists (haiku / opus) ───────────────────
# These were generated by an old multi-model system (pre-TTY-injection era).
# The scripts they referenced no longer exist; remove any survivors.
echo "[ +0 ] Purging legacy watcher plists..."
LEGACY=$(ls ~/Library/LaunchAgents/*.haiku.plist ~/Library/LaunchAgents/*.opus.plist 2>/dev/null || true)
if [ -n "$LEGACY" ]; then
    for plist in $LEGACY; do
        launchctl unload "$plist" 2>/dev/null || true
        rm -f "$plist"
        echo "         removed $(basename "$plist")"
    done
else
    echo "         none found"
fi

# ── Purge legacy new-local-agent skill ────────────────────────────────────────
# Registration is now covered by `las agent new` alone; the skill duplicated
# that flow by hand (curl/python3) instead of calling the CLI.
if [ -d ~/.claude/skills/new-local-agent ]; then
    rm -rf ~/.claude/skills/new-local-agent
    echo "         removed legacy new-local-agent skill"
fi

# ── Register launchd agent (backend) ─────────────────────────────────────────
# Starts the backend at login and restarts it on crash. See serve.sh for the
# foreground runner and backend/logging_config.py for the daily-rotating
# app-level log (logs/backend.log, 7-day retention) — StandardOutPath below
# only catches output from before that initializes, or a hard crash.
mkdir -p "$INSTALL_DIR/backend/logs"
PLIST=~/Library/LaunchAgents/com.localagent.system.plist
# This machine's federation identity (VORTEXIA_ENV_NAME) lives only here, in
# the plist — never in a checked-in file (see backend/serve.sh). Rewriting
# the plist used to drop it, silently turning cross-machine sends off after
# every `las update` (uy-mac, 2026-09-30). Keep it: from vortexia's own
# machine config first, else from the plist being replaced.
VORTEXIA_ENV_FILE="$( cd "$INSTALL_DIR/.." && pwd )/vortexia/vortexia.env"
ENV_NAME=""
[ -f "$VORTEXIA_ENV_FILE" ] && ENV_NAME=$(grep -E '^VORTEXIA_ENV_NAME=' "$VORTEXIA_ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')
[ -z "$ENV_NAME" ] && [ -f "$PLIST" ] && ENV_NAME=$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:VORTEXIA_ENV_NAME" "$PLIST" 2>/dev/null || true)
ENV_NAME_XML=""
[ -n "$ENV_NAME" ] && ENV_NAME_XML="        <key>VORTEXIA_ENV_NAME</key>
        <string>$ENV_NAME</string>"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.localagent.system</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$INSTALL_DIR/backend/serve.sh</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
$ENV_NAME_XML
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key><false/>
    </dict>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>$INSTALL_DIR/backend/logs/launchd.out.log</string>
    <key>StandardErrorPath</key><string>$INSTALL_DIR/backend/logs/launchd.err.log</string>
</dict>
</plist>
PLIST
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

# ── vortexia (dependency, not agent-business code) ─────────────────────────────
# vortexia is inter-agent messaging infrastructure this project depends on,
# not something owned by any one agent — it lives in its own sibling repo
# (../vortexia) with its own team maintaining it, the same relationship any
# external dependency has to the code that uses it. The installer's job is to
# make sure it's actually present and running, not just use it opportunistically
# if someone happened to clone it first.
VORTEXIA_REMOTE="https://github.com/haciendo/vortexia.git"
VORTEXIA_DIR="$( cd "$INSTALL_DIR/.." && pwd )/vortexia"
echo "[ +1b] Resolving vortexia dependency..."
if [ ! -d "$VORTEXIA_DIR" ]; then
    echo "         not found at $VORTEXIA_DIR — cloning $VORTEXIA_REMOTE"
    git clone -q "$VORTEXIA_REMOTE" "$VORTEXIA_DIR"
elif [ -d "$VORTEXIA_DIR/.git" ]; then
    # Already present — pull it too, same as update.sh pulling this repo.
    # Skipping this is exactly how two machines ended up running different
    # vortexia versions with an incompatible wire format for hours today.
    (cd "$VORTEXIA_DIR" && git pull -q) || echo "         ⚠️  git pull failed in $VORTEXIA_DIR — leaving existing checkout as-is"
fi
if [ -d "$VORTEXIA_DIR" ]; then
    if ! command -v node &>/dev/null; then
        echo "         ⚠️  node not found — vortexia requires Node.js >=18. Install it, then re-run install.sh."
    else
        (cd "$VORTEXIA_DIR" && npm install --no-audit --no-fund -q)
        echo "         vortexia dependencies installed"
        if [ -f "$VORTEXIA_DIR/scripts/install-service.sh" ]; then
            echo "         registering launchd agent (vortexia)..."
            bash "$VORTEXIA_DIR/scripts/install-service.sh"
        else
            echo "         ⚠️  $VORTEXIA_DIR/scripts/install-service.sh not found — vortexia checkout looks incomplete/outdated."
        fi
    fi
else
    echo "         ⚠️  could not obtain vortexia at $VORTEXIA_DIR — inter-agent messaging (las agent inject/send, TTS queue) will not work until this is resolved."
fi

# ── Create .las-agent.json if not present ─────────────────────────────────────
if [ ! -f "$INSTALL_DIR/.las-agent.json" ]; then
    TODAY=$(date '+%Y-%m-%d')
    cat > "$INSTALL_DIR/.las-agent.json" <<JSON
{
  "name": "$FAMILY",
  "voice": "Samantha",
  "pronunciation": "$FAMILY",
  "backend_url": "http://localhost:8700",
  "frontend_url": "http://localhost:8700/widget/$FAMILY",
  "created": "$TODAY",
  "response_length_hint": 40,
  "short_description": "",
  "long_description": ""
}
JSON
fi

# ── Install `las` CLI ─────────────────────────────────────────────────────────
echo "[ +1 ] Installing las CLI..."
if command -v pipx &>/dev/null; then
    pipx install -e "$INSTALL_DIR" --force -q
    # Ensure ~/.local/bin is in PATH for future shells
    pipx ensurepath --force -q 2>/dev/null || true
    echo "         las → installed via pipx"
else
    pip3 install -e "$INSTALL_DIR" -q --break-system-packages 2>/dev/null \
        || pip3 install -e "$INSTALL_DIR" -q
    echo "         las → installed via pip"
fi

# ── Verify `las` is reachable — symlink into a PATH dir only if needed ────────
# pip+Homebrew installs directly to /opt/homebrew/bin; pipx installs to ~/.local/bin.
# Only create a symlink when las lives outside the standard PATH directories.
LAS_BIN="$HOME/.local/bin/las"
if [ -f "$LAS_BIN" ]; then
    for TARGET_DIR in /opt/homebrew/bin /usr/local/bin; do
        DEST="$TARGET_DIR/las"
        if [ -d "$TARGET_DIR" ] && [ -w "$TARGET_DIR" ] && [ "$LAS_BIN" != "$DEST" ]; then
            ln -sf "$LAS_BIN" "$DEST" 2>/dev/null \
                && echo "         las → symlinked to $DEST" \
                && break
        fi
    done
fi

# Warn only if las is genuinely unreachable
if ! command -v las &>/dev/null \
   && [ ! -f "/opt/homebrew/bin/las" ] \
   && [ ! -f "/usr/local/bin/las" ]; then
    echo ""
    echo "  ⚠️  'las' not found in PATH. Add this to ~/.zshrc and reopen your terminal:"
    echo "       export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

echo ""
# ── Register the LAS channel server in Claude Code's own config ─────────────
# User-level (~/.claude.json), so every agent folder gets it. Sessions must
# then be started with `las claude` (adds the research-preview channel flag).
if command -v las >/dev/null 2>&1; then
    las claude register
else
    echo "⚠️  'las' not on PATH yet — run 'las claude register' once it is."
fi

echo "Done! Start with:"
echo "  las start"
echo "  las status"
