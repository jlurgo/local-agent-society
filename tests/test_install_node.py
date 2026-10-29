"""install.sh picks a Node >= 22.12 before anything runs node.

vortexia's launchd plist pins whichever `node` is first on PATH; an nvm v20
there (no global WebSocket) broke every vortex-relay Nostr connection on
uy-mac. The installer must choose the node itself, before the first npm.
"""
import subprocess
from pathlib import Path

INSTALL = Path(__file__).resolve().parent.parent / "install.sh"


def _selection_block() -> str:
    lines = INSTALL.read_text().splitlines()
    start = next(i for i, l in enumerate(lines) if l.startswith("node_ok()"))
    end = next(i for i, l in enumerate(lines) if l.startswith("export PATH=") and i > start)
    return "\n".join(lines[start:end + 1])


def test_node_is_chosen_before_the_first_npm_call():
    src = INSTALL.read_text()
    assert src.index("node_ok()") < src.index("npm install")


def _fake_node(dir_: Path, version: str) -> Path:
    node = dir_ / "node"
    # Runs the real node on the probe, with its own version swapped for ours.
    node.write_text(
        "#!/bin/sh\n"
        f"exec /usr/bin/env node -e \"$(printf '%s' \"$2\" | sed \"s/process.versions.node/'{version}'/\")\"\n"
    )
    node.chmod(0o755)
    return node


def test_node_ok_rejects_20_and_accepts_22_12(tmp_path):
    block = _selection_block().split("NODE_BIN=\"\"")[0]
    for version, ok in (("20.20.2", 1), ("22.11.0", 1), ("22.12.0", 0), ("26.5.0", 0)):
        d = tmp_path / version
        d.mkdir()
        node = _fake_node(d, version)
        r = subprocess.run(["bash", "-c", f"{block}\nnode_ok {node}"])
        assert r.returncode == ok, version


def test_installer_never_makes_the_checkout_an_agent():
    """The checkout is a tool on most machines: on uy-mac install.sh wrote a
    .las-agent.json named System into it, a second "System" beside the real one.
    An agent is created on purpose, with `las agent new`, never by installing."""
    assert ".las-agent.json" not in INSTALL.read_text()
