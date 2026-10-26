# Sourced by serve.sh, start.sh and install.sh: one way to get a working backend venv.
#
# Installs with "$VENV/bin/python -m pip", never "$VENV/bin/pip": the two can
# disagree. On uy-mac (2026-10-26) a venv recreated over an older one kept
# bin/python -> python3.12 while pip and pyvenv.cfg were 3.14, so every
# install landed in 3.14 and the backend ran 3.12 without kokoro_onnx —
# TTS 500 forever, and checking for bin/pip never noticed. A venv whose own
# python can't run pip is broken: set aside (not deleted) and rebuilt.
ensure_backend_venv() {
    local venv="$1" requirements="$2"
    if [ -e "$venv" ] && ! "$venv/bin/python" -m pip --version >/dev/null 2>&1; then
        local aside="$venv.broken-$(date +%Y%m%d-%H%M%S)"
        echo "backend venv at $venv is broken (its python can't run pip) — moved to $aside, rebuilding" >&2
        mv "$venv" "$aside"
    fi
    [ -e "$venv" ] || python3 -m venv "$venv"
    "$venv/bin/python" -m pip install -q --disable-pip-version-check -r "$requirements"
}
