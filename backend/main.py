"""
Local Agent Society — Backend
Port: 8700
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from typing import Optional
import json
import os
import re
import shlex
import subprocess
import tempfile
import threading
import time
import random
import socket
import uuid
from pathlib import Path
from datetime import datetime

import sys as _sys
_sys.path.insert(0, str(Path(__file__).parent))  # backend/ — for `import vortexia_client` regardless of how main.py itself was imported
import vortexia_client as vx
from logging_config import logger
from cli.agent_config import (KIND_COMMAND, KIND_TITLE_REQUEST, TARGET_ALL, TARGET_DEFAULT, BrokenAgentConfig, accepts_only_commands,
                              descriptor_for, merge_config_patch, read_agent_config, sessions_config, title_request_text,
                              write_agent_config)
from cli.path_utils import agent_config_path
from cli.terminal import hangup_tty, ring_bell, session_title_text, set_terminal_title, tty_of_pid

app = FastAPI(title="Local Agent Society", version="1.0.0")

DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)

REGISTRY_FILE = DATA_DIR / "registry.json"
QUEUE_FILE    = DATA_DIR / "queue.json"
PORTS_FILE       = DATA_DIR / "ports.json"
ATTRIBUTION_FILE = DATA_DIR / "attribution.json"
MUTED_FILE    = DATA_DIR / "muted.json"
INACTIVE_FILE      = DATA_DIR / "inactive.json"
SESSIONS_FILE      = DATA_DIR / "sessions.json"
WAKE_ENABLED_FILE  = DATA_DIR / "wake_enabled.json"

NICE_VOICES = [
    {"name": "Samantha",               "lang": "en-US", "flag": "🇺🇸"},
    {"name": "Daniel",                 "lang": "en-GB", "flag": "🇬🇧"},
    {"name": "Moira",                  "lang": "en-IE", "flag": "🇮🇪"},
    {"name": "Karen",                  "lang": "en-AU", "flag": "🇦🇺"},
    {"name": "Tessa",                  "lang": "en-ZA", "flag": "🇿🇦"},
    {"name": "Rishi",                  "lang": "en-IN", "flag": "🇮🇳"},
    {"name": "Paulina",                "lang": "es-MX", "flag": "🇲🇽"},
    {"name": "Mónica",                 "lang": "es-ES", "flag": "🇪🇸"},
    {"name": "Flo (English (US))",     "lang": "en-US", "flag": "🇺🇸"},
    {"name": "Sandy (English (US))",   "lang": "en-US", "flag": "🇺🇸"},
    {"name": "Shelley (English (US))", "lang": "en-US", "flag": "🇺🇸"},
    {"name": "Reed (English (US))",    "lang": "en-US", "flag": "🇺🇸"},
    {"name": "Eddy (English (US))",    "lang": "en-US", "flag": "🇺🇸"},
    {"name": "Jorge",                  "lang": "es-ES", "flag": "🇪🇸"},
]
NICE_VOICE_NAMES = [v["name"] for v in NICE_VOICES]


# ── helpers ───────────────────────────────────────────────────────────────────

def load_json(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            return default
    return default


def save_json(path: Path, data):
    """Write JSON atomically (tempfile + os.replace) so readers never see a partial file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(data, indent=2, ensure_ascii=False))
        os.replace(tmp_path, str(path))
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# Per-file locks: hold across the full read-modify-write so concurrent requests
# (threadpool workers + the background TTS drainer thread) never interleave and
# lose or corrupt writes to these shared JSON files / in-memory structures.
_registry_lock    = threading.Lock()
_queue_lock       = threading.Lock()
_muted_lock       = threading.Lock()
_inactive_lock     = threading.Lock()
_sessions_lock     = threading.Lock()
_wake_enabled_lock = threading.Lock()
_attribution_lock = threading.Lock()
_pending_links_lock = threading.Lock()


# ── vortexia integration ──────────────────────────────────────────────────────
#
# Inter-agent messaging (agent inject) and the TTS speak queue are both
# delivered over vortexia (a sibling MQTT broker — see
# ../vortexia/PROTOCOL.md), not AppleScript/TTY injection or `say`. This
# backend is also the port registry vortexia claims its ports from, so we
# resolve vortexia's current MQTT port by reading our own PORTS_FILE rather
# than making an HTTP round-trip to ourselves.
#
# Every vortexia call below fails soft: if vortexia isn't running, we log a
# warning and keep going — :8700 must stay usable even when vortexia is down.

SPEAK_TOPIC = "las/speak"


def _vortexia_mqtt_port() -> int:
    # Precedence lives in vortexia_client.resolve_mqtt_port (port file written
    # by the live broker first, then our registry's latest claim, then 1883) —
    # shared with `las agent listen` so both sides agree on where the broker is.
    return vx.resolve_mqtt_port(load_json(PORTS_FILE, {}))


def _vortexia_publish(topic: str, envelope: dict, retain: bool = False) -> bool:
    """Fire-and-forget publish of one envelope. Fails soft if vortexia is unreachable.

    Inbox messages are plain QoS 1, NOT retained: the broker owns a persistent
    session per agent (client id las-agent-<name>, see vortexia/PROTOCOL.md
    "Mailboxes") and queues every publish while that agent's consumer isn't
    connected — in order, one entry per message. Retaining was the previous
    mechanism and kept only the latest message per recipient (a second inject
    before the first was read overwrote it). `retain=True` is still accepted
    for callers that knowingly want the legacy single-slot behaviour; nothing
    in this backend uses it for inbox traffic anymore.
    """
    try:
        import paho.mqtt.publish as _mqtt_publish
        _mqtt_publish.single(
            topic,
            payload=json.dumps(envelope),
            qos=1,
            retain=retain,
            hostname="localhost",
            port=_vortexia_mqtt_port(),
        )
        return True
    except Exception as exc:
        logger.warning(f"[vortexia] publish to {topic!r} failed (is vortexia running?): {exc}")
        return False


def _vortexia_set_presence_online(name: str) -> bool:
    """One-shot retained presence publish — the CLI/skill 'register' call can't hold
    a persistent MQTT connection open across a session, so we publish the retained
    'online' payload directly instead of keeping a VortexiaClient connected."""
    try:
        import paho.mqtt.publish as _mqtt_publish
        _mqtt_publish.single(
            vx.presence_topic(name),
            payload="online",
            qos=1,
            retain=True,
            hostname="localhost",
            port=_vortexia_mqtt_port(),
        )
        return True
    except Exception as exc:
        logger.warning(f"[vortexia] presence publish for {name!r} failed (is vortexia running?): {exc}")
        return False


def _vortexia_poll_inbox(name: str, timeout: float = 2.0) -> list[dict]:
    """Drain whatever's waiting in `name`'s mailbox. Fails soft (returns []).

    Connects as the mailbox consumer (las-agent-<name>, persistent session)
    just long enough to receive the queued backlog. Stands down with [] when
    a live `las agent listen` already holds that session — it IS the delivery
    path while it runs, and taking the session over would kick it."""
    try:
        return vx.poll_inbox(name, host="localhost", port=_vortexia_mqtt_port(), timeout=timeout)
    except Exception as exc:
        logger.warning(f"[vortexia] poll_inbox for {name!r} failed (is vortexia running?): {exc}")
        return []


# ── TTS drainer (background thread) ──────────────────────────────────────────
#
# The queue only keeps voices from colliding if draining it is paced by
# actual PLAYBACK, not by publish speed. Playback happens inside each agent's
# own Electron widget (one process per agent — see widget-electron/main.js's
# userData scoping), so nothing in this process can hear a clip end: the
# widget has to say so. Every speak envelope therefore carries an `id`, and
# the widget that picks it up acks it back over POST /queue/ack in phases:
#
#   started — "a widget has this one" (sent on receipt, before synthesis)
#   playing — "may I play it now?" sent after synthesis, right before the
#             audio starts, with the clip's real duration. This is the
#             speaker LOCK: it is granted (`known: true`) only while this id
#             is still the drainer's current turn. A clip whose turn already
#             ended — the drainer gave up on a slow synthesis — is refused
#             and the widget drops it silently instead of talking over
#             whoever holds the turn now.
#   done    — playback finished
#   skipped — muted / no voice / synthesis or playback failed: the speaker is
#             free now, same as done
#
# _drain_one() publishes ONE envelope and then blocks until done/skipped
# before it touches the next queue entry — that is the whole serialization.
# Each phase has its own budget, so one absent or broken widget can't stall
# everyone else's speech: SPEAK_PICKUP_GRACE_S to be claimed at all,
# SPEAK_SYNTH_MAX_S to get from claimed to playing (synthesis), and once
# playing, the clip's own duration plus SPEAK_PLAY_SLACK_S.
#
# History: before the handshake (2026-09-28) the loop published as fast as
# it could and N reports in the same second were N overlapping voices. The
# handshake then released a turn on a text-length estimate that also had to
# cover synthesis (15s + len/12). On 2026-10-14 Kokoro, contended, took
# 27-82s per clip; the drainer released four turns at ~20s each, each
# release started ANOTHER synthesis, they all finished at 14:00:04 and all
# four played at once (session/widget.log). Synthesis now has its own long
# budget and a late clip can never play: it needs the `playing` grant.

SPEAK_PICKUP_GRACE_S    = 2.0    # nobody claimed it → skip, don't stall the queue
SPEAK_SYNTH_MAX_S       = 120.0  # claimed → playing: Kokoro, one clip at a time, is 2–10s; contended far more
SPEAK_MAX_WAIT_S        = 180.0  # absolute ceiling for the playback phase
SPEAK_PLAY_SLACK_S      = 8.0    # playing → done: real duration + this
SPEAK_SECONDS_PER_CHAR  = 1 / 12 # ~12 spoken chars per second, when the widget sends no duration
SPEAK_GAP_S             = 0.3    # breath between two consecutive clips

_speak_acks_lock = threading.Lock()
_speak_acks: dict[str, dict] = {}   # speak id → {"started", "playing", "done": Event, "granted": bool, "duration_s", "name"}


def _speak_timeout_for(text: str, duration_s: float | None = None) -> float:
    """How long a clip that is PLAYING may take before the turn is released."""
    spoken = duration_s if duration_s and duration_s > 0 else len(text) * SPEAK_SECONDS_PER_CHAR
    return min(SPEAK_MAX_WAIT_S, spoken + SPEAK_PLAY_SLACK_S)


def _pop_speak_request():
    with _queue_lock:
        queue = load_json(QUEUE_FILE, [])
        msg = queue.pop(0) if queue else None
        if msg is not None:
            save_json(QUEUE_FILE, queue)
    return msg


def _ack_speak(speak_id: str, phase: str, duration_ms: int | None = None) -> bool:
    """Record a widget's progress on one in-flight speak request. Returns
    False when the id isn't the current turn (already timed out, or it came
    from a previous backend process) — for `playing` that is a refusal: the
    widget must not play it."""
    with _speak_acks_lock:
        pending = _speak_acks.get(speak_id)
        if pending is None:
            return False
        pending["started"].set()
        if phase == "playing":
            pending["granted"] = True
            if duration_ms:
                pending["duration_s"] = duration_ms / 1000
            pending["playing"].set()
        elif phase != "started":   # done | skipped — either way the speaker is free
            pending["playing"].set()
            pending["done"].set()
    return True


def _retire_unless_granted(speak_id: str) -> bool:
    """End this turn — unless the widget was granted `playing` in the same
    instant (the grant and the timeout race under one lock). True = retired."""
    with _speak_acks_lock:
        pending = _speak_acks.get(speak_id)
        if pending is not None and pending["granted"]:
            return False
        _speak_acks.pop(speak_id, None)
    return True


def _drain_one() -> bool:
    """Pop one speak request, publish it, and block until its widget reports
    playback over (or a safety valve fires). Returns False when the queue was
    empty, so the caller can sleep instead of spinning."""
    msg = _pop_speak_request()
    if msg is None:
        return False
    name = msg.get("name", "")
    with _muted_lock:
        muted = load_json(MUTED_FILE, [])
    if name in muted:
        return True
    voice = msg.get("voice", "Samantha")
    text  = msg.get("text", "")
    if voice not in NICE_VOICE_NAMES:
        logger.warning(f"[tts] skipping unknown voice {voice!r} for {name!r}")
        return True
    if not text:
        return True

    speak_id = uuid.uuid4().hex
    tag = f"speak {speak_id[:8]} for {name!r}"
    pending = {"started": threading.Event(), "playing": threading.Event(), "done": threading.Event(),
               "granted": False, "duration_s": None, "name": name}
    with _speak_acks_lock:
        _speak_acks[speak_id] = pending
    t0 = time.time()
    try:
        # Published to vortexia instead of shelling out to `say`: the Electron
        # widget running for `name` picks this up off las/speak, synthesizes
        # (backend /tts/synthesize, Kokoro) and plays it — then acks (above).
        envelope = {
            "id": speak_id,
            "from": "queue",
            "to": name,
            "source": "system",
            "kind": "speak",
            "text": text,
            "voice": voice,
            "ts": int(time.time() * 1000),
        }
        if not _vortexia_publish(SPEAK_TOPIC, envelope):
            return True
        if not pending["started"].wait(SPEAK_PICKUP_GRACE_S) and _retire_unless_granted(speak_id):
            logger.warning(f"[tts] no widget picked up {tag} within {SPEAK_PICKUP_GRACE_S}s — moving on")
            return True
        if not pending["playing"].wait(SPEAK_SYNTH_MAX_S) and _retire_unless_granted(speak_id):
            logger.warning(f"[tts] {tag} not ready to play after {SPEAK_SYNTH_MAX_S:.0f}s — "
                           f"turn released; the clip will be refused if it ever arrives")
            return True
        t_play = time.time()
        timeout = _speak_timeout_for(text, pending["duration_s"])
        if not pending["done"].wait(timeout):
            logger.warning(f"[tts] {tag} never reported done {timeout:.0f}s into playback — moving on")
        elif pending["granted"]:
            logger.info(f"[tts] {tag}: ready in {t_play - t0:.1f}s, played {time.time() - t_play:.1f}s")
        time.sleep(SPEAK_GAP_S)
        return True
    finally:
        with _speak_acks_lock:
            _speak_acks.pop(speak_id, None)


# ONE drainer per machine. The thread starts at import, so a second backend
# process (a stray `backend/start.sh` next to launchd's — it has happened,
# see docs/adr/0002) or a multi-worker uvicorn would run a second drainer on
# the same queue file and two voices at once. An exclusive flock decides;
# the loser keeps trying, so it takes over if the winner dies.
TTS_DRAINER_LOCK = DATA_DIR / "tts-drainer.lock"


def _acquire_drainer_lock():
    import fcntl
    TTS_DRAINER_LOCK.parent.mkdir(parents=True, exist_ok=True)
    handle = open(TTS_DRAINER_LOCK, "a")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except OSError:
        handle.close()
        return None


def tts_drainer():
    lock = _acquire_drainer_lock()
    if lock is None:
        logger.warning(f"[tts] another backend process drains the speech queue ({TTS_DRAINER_LOCK}) — standing by")
        while lock is None:
            time.sleep(5)
            lock = _acquire_drainer_lock()
        logger.info("[tts] took over the speech queue")
    while True:
        try:
            busy = _drain_one()
        except Exception as exc:
            logger.error(f"[tts] drainer iteration failed: {exc}")
            busy = False
        if not busy:
            time.sleep(0.4)


threading.Thread(target=tts_drainer, daemon=True).start()


# ── models ────────────────────────────────────────────────────────────────────

class AgentRegistration(BaseModel):
    name:          str
    voice:         str
    path:          str
    backend_url:   Optional[str] = "http://localhost:8700"
    frontend_url:  Optional[str] = None
    pronunciation: Optional[str] = None


class PortRegistration(BaseModel):
    port:         int
    app:          str
    local_agent:  str
    path:         str


class PortClaimRequest(BaseModel):
    port:        Optional[int] = None
    app:         str
    local_agent: str
    path:        str
    start:       int = 9000
    end:         int = 9999


class SpeakRequest(BaseModel):
    text:   str = Field(max_length=10000)
    voice:  str
    name:   str


class SpeakAckRequest(BaseModel):
    """A widget reporting progress on one speak envelope — see _drain_one()."""
    id:     str = Field(min_length=1, max_length=64)
    phase:  str = Field(pattern=r"^(started|playing|done|skipped)$")
    reason: Optional[str] = Field(default=None, max_length=200)
    duration_ms: Optional[int] = Field(default=None, ge=0, le=3_600_000)   # with `playing`: the clip's real length


class AttributionEntry(BaseModel):
    file:      str
    agent:     str
    name:      str
    timestamp: str
    project:   str


class RenameRequest(BaseModel):
    new_name:      str
    pronunciation: Optional[str] = None


class InjectRequest(BaseModel):
    message:     str = Field(max_length=10000)
    source:      str           = "voice"   # "voice" | "agent" | "external" | "raw"
    from_agent:  Optional[str] = None
    # `tty` / `queue` are no longer meaningful — delivery is 100% vortexia now
    # (no TTY concept, no local pending-queue file). Kept out of the model on
    # purpose; any caller still sending them (e.g. an unrebuilt widget) is
    # unaffected since pydantic ignores unknown fields by default.


class SendRequest(BaseModel):
    """Generic point-to-point OR scope-broadcast send — see send_message().
    Exactly one of `to`/`scope` must be set; pydantic doesn't express an
    XOR directly, so send_message() itself enforces it."""
    message:     str = Field(max_length=10000)
    to:          Optional[str] = None   # exact id, optionally "name@env"
    scope:       Optional[str] = None   # free-text scope/intent for broadcast
    source:      str           = "agent"
    from_agent:  Optional[str] = None
    # Which of the recipient's connected sessions (docs/adr/0004 phase 2):
    # unset = the default one (last used) via the agent inbox; a session id
    # or a runtime name ("claude", "codex", "shell") = that one only;
    # all_sessions = every live session, one publish each (like --children).
    session:      Optional[str] = None
    all_sessions: bool          = False
    # Envelope kind: "message" (prose) or "command" (something a shell runs —
    # ShellSink only ever runs kind=command). Unset: prose, except that a
    # child which accepts nothing but commands (its runtime descriptor) is
    # handed everything as a command.
    kind:         Optional[str] = None
    # Also hand the recipient's DEFAULT session a for-the-record copy
    # (kind "cc") when the message went to another session — e.g. a command
    # sent to the shell that the Claude session should know about. The
    # recipient's own `sessions.cc_default` (its .las-agent.json) turns this
    # on for every send; this flag turns it on for this one.
    cc:           bool          = False


class SessionRegisterRequest(BaseModel):
    """A bridge announcing one connected runtime session for an agent."""
    sid:     str = Field(min_length=1, max_length=120)
    runtime: str = Field(min_length=1, max_length=40)   # claude | codex | shell | stdout | exec
    pid:     int
    cwd:     str = ""


class SessionTitleRequest(BaseModel):
    """What one session is working on — rung 0 of the scope ladder one level down (soft target 34 chars, never truncated)."""
    title: str = Field(max_length=144)


class TerminalRequest(BaseModel):
    model:    str            = "Default"
    model_id: Optional[str] = None        # claude --model flag value
    bare:     bool           = False       # open plain shell, no claude
    resume:   bool           = False       # run `claude --resume`


# ── routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "time": datetime.now().isoformat()}



@app.get("/voices/random")
def random_voice():
    registry = load_json(REGISTRY_FILE, {})
    taken = {v["voice"] for v in registry.values() if "voice" in v}
    available = [v["name"] for v in NICE_VOICES if v["name"] not in taken]
    if not available:
        available = NICE_VOICE_NAMES  # pool exhausted — allow repeats
    return {"voice": random.choice(available)}


@app.get("/voices")
def list_voices():
    return {"voices": NICE_VOICES}


@app.get("/voices/{name}")
def get_voice(name: str):
    voice = next((v for v in NICE_VOICES if v["name"] == name), None)
    if not voice:
        raise HTTPException(status_code=404, detail="Voice not found")
    return voice


# ── local text-to-speech (Kokoro-82M via kokoro-onnx) ───────────────────────
#
# widget-electron used to run Kokoro in-process (kokoro-js, in Electron's
# main/Node process). That broke when packaged: electron-builder's own
# native-module rebuild step re-flattens node_modules, collapsing the
# onnxruntime-common version Kokoro needs back down to the older one Whisper
# (@xenova/transformers) pins, which crashes Kokoro's tokenizer at runtime.
# Moving synthesis here sidesteps that packaging conflict entirely — one
# Python process, one onnxruntime — and as a bonus, kokoro-onnx's espeak-ng
# phonemizer is a real native binary (via espeakng-loader), not the WASM
# build kokoro-js uses, which is what made Spanish voices (ef_/em_) crash in
# Node but work fine here.
#
# Model files are NOT bundled in the repo (~340MB) — download once with:
#   curl -L -o backend/data/kokoro/kokoro-v1.0.onnx \
#     https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
#   curl -L -o backend/data/kokoro/voices-v1.0.bin \
#     https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
KOKORO_DIR = DATA_DIR / "kokoro"
KOKORO_MODEL_PATH = KOKORO_DIR / "kokoro-v1.0.onnx"
KOKORO_VOICES_PATH = KOKORO_DIR / "voices-v1.0.bin"

_kokoro = None
_kokoro_lock = threading.Lock()


def get_kokoro():
    """Lazily create (and memoize) the Kokoro instance — first call pays
    model-load time, every call after is just inference."""
    global _kokoro
    if _kokoro is None:
        with _kokoro_lock:
            if _kokoro is None:
                from kokoro_onnx import Kokoro
                logger.info(f"tts: loading kokoro model from {KOKORO_MODEL_PATH}")
                _kokoro = Kokoro(str(KOKORO_MODEL_PATH), str(KOKORO_VOICES_PATH))
                logger.info("tts: kokoro model loaded")
    return _kokoro


class TTSRequest(BaseModel):
    text: str
    voice: str = "af_heart"
    lang: str = "en-us"
    speed: float = 1.0


@app.post("/tts/synthesize")
def tts_synthesize(req: TTSRequest):
    if not KOKORO_MODEL_PATH.exists() or not KOKORO_VOICES_PATH.exists():
        raise HTTPException(
            status_code=503,
            detail=f"Kokoro model files not found under {KOKORO_DIR} — see the download instructions in main.py",
        )
    try:
        kokoro = get_kokoro()
        samples, sample_rate = kokoro.create(req.text, voice=req.voice, speed=req.speed, lang=req.lang)
    except Exception as e:
        logger.error(f"tts: synthesis failed (voice={req.voice!r} lang={req.lang!r}): {e}")
        raise HTTPException(status_code=500, detail=str(e))
    import io
    import soundfile as sf
    from fastapi.responses import Response as FastResponse
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV")
    return FastResponse(content=buf.getvalue(), media_type="audio/wav")


# ── agents ────────────────────────────────────────────────────────────────────

@app.get("/agents")
def list_agents():
    with _registry_lock:
        registry = load_json(REGISTRY_FILE, {})
    with _inactive_lock:
        inactive = load_json(INACTIVE_FILE, [])
    with _wake_enabled_lock:
        wake_enabled = load_json(WAKE_ENABLED_FILE, [])
    return {
        name: {**info, "inactive": name in inactive, "wake_enabled": name in wake_enabled}
        for name, info in registry.items()
    }


@app.post("/agents")
def register_agent(agent: AgentRegistration):
    with _registry_lock:
        registry = load_json(REGISTRY_FILE, {})
        data = agent.model_dump()
        data["backend_url"] = "http://localhost:8700"
        data["frontend_url"] = f"http://localhost:8700/widget/{agent.name}"
        registry[agent.name] = {**data, "registered_at": datetime.now().isoformat()}
        save_json(REGISTRY_FILE, registry)
    return {"ok": True, "name": agent.name}


@app.delete("/agents/{name}")
def unregister_agent(name: str):
    with _registry_lock:
        registry = load_json(REGISTRY_FILE, {})
        if name not in registry:
            raise HTTPException(status_code=404, detail="Agent not found")
        del registry[name]
        save_json(REGISTRY_FILE, registry)
    return {"ok": True}


# ── connected sessions (docs/adr/0004, phase 2) ──────────────────────────────
#
# One agent, several runtimes at once: a Claude session, a Codex session, a
# plain shell — each registered here by its bridge (bridge/) with a session
# id, runtime, pid and cwd. The DEFAULT session is the last one used
# (highest lastActiveAt); it is the one that holds the agent-level mailbox,
# so a plain `send --to Name` reaches it. The backend publishes the default's
# id, retained, on las/agent/<name>/default-session every time it changes:
# that is how a bridge learns whether to hold or release the agent mailbox
# without any bridge talking to another. Sessions whose process is gone are
# pruned on every read — a crashed bridge can't hold the default forever.

def _pid_alive(pid) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, TypeError, ValueError):
        return False


MAILBOX_DROP_TOPIC = "vortexia/control/mailbox/drop"


def _drop_session_mailbox(name: str, sid: str, *, force: bool) -> bool:
    """Ask the broker to drop a gone session's persistent mailbox (vortexia/PROTOCOL.md "Dropping a mailbox").

    Without this, every closed terminal left its queue behind until the
    30-day TTL. Fire-and-forget: the answer comes on .../drop/result and
    nothing here depends on it. `force` only when the session itself said it
    is leaving (its bridge may still be connected for a moment); a pruned
    dead process never forces — if something reconnected, the broker keeps it.
    """
    client_id = vx.session_mailbox_client_id(name, sid)
    return _vortexia_publish(MAILBOX_DROP_TOPIC, {"clientId": client_id, "id": f"drop-{client_id}-{int(time.time() * 1000)}", "force": force})


def _load_sessions(name: str) -> dict:
    """{sid: session}, pruned of dead processes (caller holds _sessions_lock)."""
    all_sessions = load_json(SESSIONS_FILE, {})
    sessions = all_sessions.get(name, {})
    live = {sid: s for sid, s in sessions.items() if _pid_alive(s.get("pid"))}
    if live != sessions:
        all_sessions[name] = live
        save_json(SESSIONS_FILE, all_sessions)
        for sid in set(sessions) - set(live):
            _drop_session_mailbox(name, sid, force=False)
    return live


def _save_sessions(name: str, sessions: dict) -> None:
    all_sessions = load_json(SESSIONS_FILE, {})
    if sessions:
        all_sessions[name] = sessions
    else:
        all_sessions.pop(name, None)
    save_json(SESSIONS_FILE, all_sessions)


def _default_sid(sessions: dict) -> str | None:
    if not sessions:
        return None
    return max(sessions.values(), key=lambda s: (s.get("lastActiveAt", 0), s.get("startedAt", 0)))["sid"]


def _publish_default_session(name: str, sessions: dict) -> bool:
    sid = _default_sid(sessions)
    payload = {"sid": sid, "runtime": sessions[sid]["runtime"] if sid else None, "ts": int(time.time() * 1000)}
    return _vortexia_publish(vx.default_session_topic(name), payload, retain=True)


def _resolve_session(sessions: dict, selector: str) -> dict | None:
    """`selector` is a session id, or a runtime name (the most recently used session of that runtime)."""
    if selector in sessions:
        return sessions[selector]
    of_runtime = [s for s in sessions.values() if s.get("runtime") == selector]
    return max(of_runtime, key=lambda s: s.get("lastActiveAt", 0)) if of_runtime else None


# ── the agent's own file: .las-agent.json (cli/agent_config.py) ─────────────
#
# The backend never owns this file — the agent's folder does — but it is the
# one process that knows every agent's path, so the widget and `las agent
# target` read and patch it through here instead of each finding the file.

def _agent_config_file(name: str, registry: dict | None = None) -> Path | None:
    registry = load_json(REGISTRY_FILE, {}) if registry is None else registry
    path = registry.get(name, {}).get("path")
    return agent_config_path(path) if path else None


def _agent_config(name: str, registry: dict | None = None) -> dict:
    file = _agent_config_file(name, registry)
    return read_agent_config(file) if file else {}


def _config_view(name: str) -> dict:
    file = _agent_config_file(name)
    config = read_agent_config(file) if file else {}
    return {"agent": name, "file": str(file) if file else None, "config": config, "sessions": sessions_config(config)}


@app.get("/agents/{name}/config")
def get_agent_config(name: str):
    """`name`'s .las-agent.json as written, plus its effective `sessions` section (defaults filled in)."""
    if name not in load_json(REGISTRY_FILE, {}):
        raise HTTPException(status_code=404, detail="Agent not found")
    return _config_view(name)


@app.patch("/agents/{name}/config")
def patch_agent_config(name: str, patch: dict):
    """Merge `patch` into `name`'s .las-agent.json (top-level keys replaced, `sessions` merged one level deep)."""
    file = _agent_config_file(name)
    if file is None:
        raise HTTPException(status_code=404, detail="Agent not found, or it has no .las-agent.json")
    if "name" in patch:
        raise HTTPException(status_code=422, detail="rename with `las agent rename`, not a config patch")
    sessions = patch.get("sessions")
    if sessions is not None and (not isinstance(sessions, dict) or ("target" in sessions and not (isinstance(sessions["target"], str) and sessions["target"]))):
        raise HTTPException(status_code=422, detail="sessions.target must be a non-empty string: default, all, a runtime or a session id")
    with _sessions_lock:
        try:
            current = read_agent_config(file, strict=True)
        except BrokenAgentConfig as exc:
            # Never replace a hand-edited file with the patch alone.
            raise HTTPException(status_code=409, detail=f"{exc} — fix it by hand, then retry")
        write_agent_config(file, merge_config_patch(current, patch))
    return _config_view(name)


def _session_summaries(name: str, sessions: dict, policy: dict | None = None) -> list:
    """One compact row per session — enough for another agent to pick where to send."""
    policy = policy or sessions_config(_agent_config(name))
    default = _default_sid(sessions)
    ordered = sorted(sessions.values(), key=lambda s: s.get("lastActiveAt", 0), reverse=True)
    return [{"sid": s["sid"], "runtime": s.get("runtime", "?"), "title": s.get("title", ""),
             "intelligent": descriptor_for(policy, s.get("runtime", "")).get("intelligent", True),
             "default": s["sid"] == default, "lastActiveAt": s.get("lastActiveAt", 0)} for s in ordered]


@app.get("/sessions")
def society_sessions():
    """Every agent's connected sessions in one call — the society map an agent keeps in mind before sending."""
    registry = load_json(REGISTRY_FILE, {})
    out = {}
    with _sessions_lock:
        for name in sorted(load_json(SESSIONS_FILE, {})):
            if name not in registry:
                continue
            sessions = _load_sessions(name)
            if sessions:
                policy = sessions_config(_agent_config(name, registry))
                out[name] = {"target": policy["target"], "sessions": _session_summaries(name, sessions, policy)}
    return {"agents": out, "ts": int(time.time() * 1000)}


def _sessions_view(name: str, sessions: dict) -> dict:
    """The sessions (children) of `name`, each carrying its runtime's descriptor, plus where the agent wants a plain send to land."""
    default = _default_sid(sessions)
    policy = sessions_config(_agent_config(name))
    ordered = sorted(sessions.values(), key=lambda s: s.get("lastActiveAt", 0), reverse=True)
    rows = [{**s, **descriptor_for(policy, s.get("runtime", "")), "default": s["sid"] == default} for s in ordered]
    return {"agent": name, "default": default, "target": policy["target"], "cc_default": policy["cc_default"], "sessions": rows}


@app.get("/agents/{name}/sessions")
def list_sessions(name: str):
    """Connected runtime sessions of `name`, most recently used first; `default` names the one a plain send reaches."""
    with _sessions_lock:
        return _sessions_view(name, _load_sessions(name))


@app.post("/agents/{name}/sessions")
def register_session(name: str, body: SessionRegisterRequest):
    """A bridge connected: it becomes the default (a session you just opened is the one you're using)."""
    registry = load_json(REGISTRY_FILE, {})
    if name not in registry:
        raise HTTPException(status_code=404, detail="Agent not found")
    now = int(time.time() * 1000)
    with _sessions_lock:
        sessions = _load_sessions(name)
        # A bridge that re-registers the same sid (backend restart) keeps the title it was given.
        title = sessions.get(body.sid, {}).get("title", "")
        sessions[body.sid] = {"sid": body.sid, "agent": name, "runtime": body.runtime, "pid": body.pid, "cwd": body.cwd, "title": title, "startedAt": now, "lastActiveAt": now}
        _save_sessions(name, sessions)
        published = _publish_default_session(name, sessions)
        view = _sessions_view(name, sessions)
    return {"ok": True, "published": published, **view}


@app.post("/agents/{name}/sessions/{sid}/touch")
def touch_session(name: str, sid: str):
    """Activity on a session (a delivery, a reply) — it becomes the default."""
    with _sessions_lock:
        sessions = _load_sessions(name)
        if sid not in sessions:
            raise HTTPException(status_code=404, detail="Session not found")
        was_default = _default_sid(sessions)
        sessions[sid]["lastActiveAt"] = int(time.time() * 1000)
        _save_sessions(name, sessions)
        published = _publish_default_session(name, sessions) if was_default != sid else True
        view = _sessions_view(name, sessions)
    return {"ok": True, "published": published, **view}


@app.put("/agents/{name}/sessions/{sid}/title")
def set_session_title(name: str, sid: str, body: SessionTitleRequest):
    """Name what one session is working on (`las agent title`). Not activity: the default session does not change."""
    with _sessions_lock:
        sessions = _load_sessions(name)
        if sid not in sessions:
            raise HTTPException(status_code=404, detail=f"{name} has no connected session {sid!r}")
        sessions[sid]["title"] = " ".join(body.title.split())
        _save_sessions(name, sessions)
        view = _sessions_view(name, sessions)
    return {"ok": True, **view}


@app.post("/agents/{name}/sessions/titles/request")
def request_session_titles(name: str):
    """Ask every connected intelligent session of `name` to title itself (the widget's refresh button).

    One `title-request` envelope per session, straight into its own mailbox —
    never the agent mailbox, so each session knows the request is about IT
    (the text carries its sid). A shell cannot describe itself: skipped. The
    answers arrive asynchronously, as `las agent title` calls.
    """
    if name not in load_json(REGISTRY_FILE, {}):
        raise HTTPException(status_code=404, detail="Agent not found")
    policy = sessions_config(_agent_config(name))
    with _sessions_lock:
        sessions = _load_sessions(name)
    asked, skipped = [], []
    ts = int(time.time() * 1000)
    for s in sessions.values():
        if not descriptor_for(policy, s.get("runtime", "")).get("intelligent", True):
            skipped.append(s["sid"])
            continue
        envelope = {"from": name, "to": name, "source": "system", "kind": KIND_TITLE_REQUEST, "session": s["sid"],
                    "text": title_request_text(name, s["sid"]), "ts": ts}
        if _vortexia_publish(vx.session_inbox_topic(name, s["sid"]), envelope, retain=False):
            asked.append(s["sid"])
    return {"ok": True, "asked": asked, "skipped": skipped}


@app.delete("/agents/{name}/sessions/{sid}")
def unregister_session(name: str, sid: str):
    """A bridge is leaving; the next most recently used session (if any) becomes the default."""
    with _sessions_lock:
        sessions = _load_sessions(name)
        removed = sessions.pop(sid, None) is not None
        _save_sessions(name, sessions)
        if removed:
            _drop_session_mailbox(name, sid, force=True)
        published = _publish_default_session(name, sessions)
        view = _sessions_view(name, sessions)
    return {"ok": True, "removed": removed, "published": published, **view}


# ── finding and closing a session's terminal (the widget's children list) ────
#
# A session's pid is its bridge's, which shares the session's controlling
# tty. The beacon gives that terminal a unique title for a few seconds — the
# widget then asks the terminal app to focus whichever terminal carries it
# (Ghostty exposes titles, not ttys) — plus a bell; the session's own title
# comes back afterwards. Close hangs the tty up, like closing the window.

SESSION_BEACON_SECONDS = 6


def _session_tty(name: str, sid: str) -> tuple[dict, str]:
    with _sessions_lock:
        session = _load_sessions(name).get(sid)
    if not session:
        raise HTTPException(status_code=404, detail=f"{name} has no connected session {sid!r}")
    tty = tty_of_pid(session.get("pid"))
    if not tty:
        raise HTTPException(status_code=409, detail=f"session {sid!r} has no terminal")
    return session, tty


@app.post("/agents/{name}/sessions/{sid}/beacon")
def session_beacon(name: str, sid: str):
    """Make one session's terminal findable: a unique title and a bell, then its own title again."""
    session, tty = _session_tty(name, sid)
    runtime = session.get("runtime")
    beacon = f"◉ {name} · {runtime} — here ◉ {uuid.uuid4().hex[:6]}"
    if not set_terminal_title(beacon, tty=tty):
        raise HTTPException(status_code=409, detail=f"cannot write to {tty}")
    ring_bell(tty)
    restore = session_title_text(name, session.get("title", ""), runtime)
    timer = threading.Timer(SESSION_BEACON_SECONDS, set_terminal_title, args=(restore,), kwargs={"tty": tty})
    timer.daemon = True
    timer.start()
    return {"ok": True, "tty": tty, "beacon": beacon}


@app.post("/agents/{name}/sessions/{sid}/close")
def close_session(name: str, sid: str):
    """Close one session's terminal (SIGHUP its tty) and drop it the way a leaving bridge would."""
    _, tty = _session_tty(name, sid)
    if not hangup_tty(tty):
        raise HTTPException(status_code=409, detail=f"could not hang up {tty}")
    return {**unregister_session(name, sid), "tty": tty}


@app.get("/agents/{name}/hierarchy")
def agent_hierarchy(name: str, deep: bool = False):
    """Parent and subordinates of `name`, derived purely from registered paths.

    The folders are the source of truth: an agent registered under another
    agent's path is its subordinate. Nothing is declared in .las-agent.json
    (see cli/hierarchy.py). `deep=true` lists every descendant instead of
    only direct children."""
    from cli.hierarchy import children_of, parent_of
    with _registry_lock:
        registry = load_json(REGISTRY_FILE, {})
    if name not in registry:
        raise HTTPException(status_code=404, detail="Agent not found")
    children = children_of(name, registry, deep=deep)
    return {
        "name": name,
        "path": registry[name].get("path"),
        "parent": parent_of(name, registry),
        "children": [
            {"name": c, "path": registry[c].get("path"), "voice": registry[c].get("voice")}
            for c in children
        ],
        "deep": deep,
    }


@app.patch("/agents/{name}")
def rename_agent(name: str, body: RenameRequest):
    with _registry_lock:
        registry = load_json(REGISTRY_FILE, {})
        if name not in registry:
            raise HTTPException(status_code=404, detail="Agent not found")
        new_name = body.new_name.strip()
        if not new_name:
            raise HTTPException(status_code=422, detail="new_name must not be empty")
        if new_name in registry and new_name != name:
            raise HTTPException(status_code=409, detail=f"Agent '{new_name}' already exists")
        entry = registry.pop(name)
        entry["name"] = new_name
        entry["frontend_url"] = f"http://localhost:8700/widget/{new_name}"
        if body.pronunciation is not None:
            entry["pronunciation"] = body.pronunciation
        elif entry.get("pronunciation") == name:
            entry["pronunciation"] = new_name
        registry[new_name] = entry
        save_json(REGISTRY_FILE, registry)
    return {"ok": True, "old_name": name, "new_name": new_name}


# Pending TTY links registered via `las link` CLI command
_pending_links: dict[str, str] = {}

_ports_lock = threading.Lock()


def _port_is_free(port: int, registered: set) -> bool:
    if port in registered:
        return False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("localhost", port)) != 0


# ── ports ─────────────────────────────────────────────────────────────────────

@app.get("/ports")
def list_ports():
    return load_json(PORTS_FILE, {})


@app.post("/ports")
def register_port(reg: PortRegistration):
    ports = load_json(PORTS_FILE, {})
    ports[str(reg.port)] = {
        **reg.model_dump(),
        "registered_at": datetime.now().isoformat(),
    }
    save_json(PORTS_FILE, ports)
    return {"ok": True, "port": reg.port}


@app.delete("/ports/{port}")
def unregister_port(port: int):
    ports = load_json(PORTS_FILE, {})
    if str(port) not in ports:
        raise HTTPException(status_code=404, detail="Port not registered")
    del ports[str(port)]
    save_json(PORTS_FILE, ports)
    return {"ok": True}


@app.get("/ports/free")
def get_free_port(start: int = 9000, end: int = 9999):
    with _ports_lock:
        ports = load_json(PORTS_FILE, {})
        registered = {int(k) for k in ports.keys()}
        for port in range(start, end + 1):
            if _port_is_free(port, registered):
                return {"port": port}
    raise HTTPException(status_code=503, detail="No free ports available")


@app.post("/ports/claim")
def claim_port(req: PortClaimRequest):
    with _ports_lock:
        ports = load_json(PORTS_FILE, {})
        registered = {int(k) for k in ports.keys()}

        if req.port is not None:
            if not _port_is_free(req.port, registered):
                raise HTTPException(status_code=409, detail=f"Port {req.port} is already taken")
            chosen = req.port
        else:
            chosen = None
            for p in range(req.start, req.end):
                if _port_is_free(p, registered):
                    chosen = p
                    break
            if chosen is None:
                raise HTTPException(status_code=503, detail="No free ports available in range")

        # A re-claim from the same app+local_agent supersedes its earlier
        # claim(s) — without this, a service that restarts onto a new port
        # (e.g. vortexia finding its old port occupied) leaves its dead old
        # entry in the registry forever, and any lookup that isn't careful
        # about picking the most recent one keeps targeting the dead port.
        stale = [
            port for port, info in ports.items()
            if info.get("app") == req.app and info.get("local_agent") == req.local_agent
            and port != str(chosen)
        ]
        for port in stale:
            del ports[port]

        ports[str(chosen)] = {
            "port": chosen,
            "app": req.app,
            "local_agent": req.local_agent,
            "path": req.path,
            "registered_at": datetime.now().isoformat(),
        }
        save_json(PORTS_FILE, ports)
        return {"port": chosen}


# ── TTS queue ─────────────────────────────────────────────────────────────────

@app.post("/queue/speak")
def enqueue_speak(req: SpeakRequest):
    with _queue_lock:
        queue = load_json(QUEUE_FILE, [])
        queue.append({"text": req.text, "voice": req.voice, "name": req.name})
        save_json(QUEUE_FILE, queue)
        length = len(queue)
    return {"ok": True, "queue_length": length}


@app.post("/queue/ack")
def ack_speak(req: SpeakAckRequest):
    """The widget playing a speak envelope reports `started`, asks `playing`
    right before the audio starts, then reports `done` (or `skipped` with a
    reason). `known: false` means that id is no longer the current turn:
    harmless for the other phases, a refusal for `playing` (don't play)."""
    known = _ack_speak(req.id, req.phase, req.duration_ms)
    if req.phase == "playing" and not known:
        logger.info(f"[tts] speak {req.id[:8]} refused: its turn already ended — not played over the current one")
    if req.phase == "skipped":
        logger.info(f"[tts] speak {req.id[:8]} skipped by widget: {req.reason or 'no reason given'}")
    return {"ok": True, "known": known}


@app.get("/queue")
def get_queue():
    with _queue_lock:
        return load_json(QUEUE_FILE, [])


@app.delete("/queue")
def clear_queue():
    with _queue_lock:
        save_json(QUEUE_FILE, [])
    return {"ok": True}


# ── agent inject ─────────────────────────────────────────────────────────────
# Delivery is 100% vortexia now (see the "vortexia integration" section
# above) — no AppleScript/TTY injection, no on-disk pending-message queue.
# The old file-based pending queue (session/pending-injects.json, drained
# into a live TTY on the next inject) is gone; vortexia's own inbox is the
# queue now, drained via GET /agents/{name}/vortexia/poll (see below).

from cli.path_utils import find_nearest_agent_dir as _find_nearest_agent_dir


def _claude_pids_for_path(agent_path: str) -> list[str]:
    """Return PIDs of all claude processes whose nearest .las-agent.json matches agent_path."""
    try:
        ps_out = subprocess.run(
            ["ps", "-ax", "-o", "pid=,command="], capture_output=True, text=True, timeout=5
        ).stdout
        pids = []
        for line in ps_out.splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split(None, 1)
            if len(parts) < 2:
                continue
            pid, cmd = parts
            if pid.isdigit() and "claude" in cmd and "Claude.app" not in cmd:
                pids.append(pid)
        matched = []
        for pid in pids:
            lsof_out = subprocess.run(
                ["/usr/sbin/lsof", "-p", pid, "-a", "-d", "cwd"],
                capture_output=True, text=True, timeout=5
            ).stdout
            for line in lsof_out.splitlines()[1:]:
                parts = line.split()
                if not parts:
                    continue
                cwd = parts[-1]
                nearest = _find_nearest_agent_dir(cwd)
                if nearest == agent_path:
                    matched.append(pid)
                    break
        return matched
    except Exception:
        return []


def _find_claude_tty(agent_path: str) -> str | None:
    """Find the TTY of the first claude process whose cwd is agent_path."""
    for pid in _claude_pids_for_path(agent_path):
        try:
            tty = subprocess.run(
                ["ps", "-p", pid, "-o", "tty="],
                capture_output=True, text=True, timeout=5
            ).stdout.strip()
            if tty and tty != "??":
                return tty
        except Exception:
            continue
    return None


def _find_all_claude_ttys(agent_path: str) -> list[str]:
    """Return ALL TTYs of claude processes whose cwd is agent_path (deduplicated, ordered)."""
    seen: list[str] = []
    for pid in _claude_pids_for_path(agent_path):
        try:
            ps_out = subprocess.run(
                ["ps", "-p", pid, "-o", "tty=,comm="],
                capture_output=True, text=True, timeout=5
            ).stdout.strip()
            parts = ps_out.split(None, 1)
            tty  = parts[0] if parts else ""
            comm = parts[1] if len(parts) > 1 else ""
            print(f"[ttys] path={agent_path!r} pid={pid} tty={tty!r} comm={comm!r}", flush=True)
            if tty and tty != "??" and tty not in seen:
                seen.append(tty)
        except Exception:
            continue
    return seen


# Strict TTY device path format — guards every AppleScript path that interpolates a tty.
TTY_RE = re.compile(r"^/dev/ttys\d{3,4}$")


def _run_osascript_with_argv(script: str, args: list[str], timeout: int = 4) -> subprocess.CompletedProcess:
    """Run an AppleScript ("on run argv ...") from a short-lived temp file, passing
    `args` as argv so untrusted text is never interpolated into the script source."""
    fd, tmp_path = tempfile.mkstemp(suffix=".applescript")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(script)
        return subprocess.run(
            ["osascript", tmp_path, *args], capture_output=True, text=True, timeout=timeout
        )
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _inject_via_iterm(tty: str, message: str) -> dict:
    tty_dev = tty if tty.startswith("/") else f"/dev/{tty}"
    delay_s = round(min(0.05 + len(message) * 0.002, 1.0), 3)
    # `message` is passed as argv item 1, never interpolated into the script source.
    script = f'''
on run argv
    set msg to item 1 of argv
    set foundIt to false
    set sessionCount to 0
    tell application "iTerm2"
        repeat with w in windows
            repeat with t in tabs of w
                repeat with s in sessions of t
                    set sessionCount to sessionCount + 1
                    try
                        if (tty of s) is equal to "{tty_dev}" then
                            tell s
                                write text msg newline NO
                                delay {delay_s}
                                write text (ASCII character 13) newline NO
                            end tell
                            set foundIt to true
                        end if
                    end try
                end repeat
            end repeat
        end repeat
    end tell
    if foundIt then
        return "ok|sessions=" & sessionCount
    end if
    return "not_found|sessions=" & sessionCount
end run
'''
    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    try:
        result = _run_osascript_with_argv(script, [message], timeout=4)
        success = result.returncode == 0 and "ok" in result.stdout
        return {
            "success": success,
            "returncode": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
            "ts": ts,
            "delay_s": delay_s,
            "text_len": len(message),
            "tty": tty_dev,
        }
    except Exception as exc:
        return {
            "success": False,
            "returncode": -1,
            "stdout": "",
            "stderr": str(exc),
            "ts": ts,
            "delay_s": delay_s,
            "text_len": len(message),
            "tty": tty_dev,
        }


def _focus_via_iterm(tty: str) -> dict:
    tty_dev = tty if tty.startswith("/") else f"/dev/{tty}"
    script = f'''
set foundIt to false
set sessionCount to 0
set seenTTYs to ""
tell application "iTerm2"
    set winCount to count of windows
    repeat with wi from 1 to winCount
        set tabCount to count of tabs of window wi
        repeat with ti from 1 to tabCount
            set sesCount to count of sessions of tab ti of window wi
            repeat with si from 1 to sesCount
                set sessionCount to sessionCount + 1
                set sessionTty to ""
                try
                    set sessionTty to tty of session si of tab ti of window wi
                    set seenTTYs to seenTTYs & sessionTty & "|"
                end try
                if sessionTty contains "{tty}" then
                    set foundIt to true
                    -- capture references before reordering (index shifts after set index)
                    set theWin to window wi
                    set theTab to tab ti of theWin
                    set theSes to session si of theTab
                    set index of theWin to 1
                    -- NOT "set current tab of theWin to theTab" — that raises
                    -- "AppleEvent handler failed (-10000)" on this iTerm2
                    -- version (reproduced directly via osascript). Selecting
                    -- the session already switches to its parent tab per
                    -- iTerm2's own scripting dictionary, so the explicit
                    -- current-tab assignment was both redundant and broken.
                    tell theSes to select
                    activate
                    return "ok|sessions=" & sessionCount & "|ttys=" & seenTTYs
                end if
            end repeat
        end repeat
    end repeat
end tell
if foundIt then
    return "ok|sessions=" & sessionCount & "|ttys=" & seenTTYs
end if
return "not_found|sessions=" & sessionCount & "|ttys=" & seenTTYs
'''
    try:
        result = subprocess.run(
            ["osascript", "-e", script], capture_output=True, text=True, timeout=4
        )
        success = result.returncode == 0 and "ok" in result.stdout
        return {
            "success": success,
            "returncode": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
            "tty": tty_dev,
        }
    except Exception as exc:
        return {
            "success": False,
            "returncode": -1,
            "stdout": "",
            "stderr": str(exc),
            "tty": tty_dev,
        }


@app.post("/agents/{name}/focus")
def focus_agent_terminal(name: str):
    """Bring the agent's iTerm2 window/tab/session to the foreground.

    Wake-via-vortexia fallback: if no live session is found AND the agent is
    both inactive and opted into wake-enabled, open a fresh iTerm2 window
    running `las claude` in its directory instead of just reporting "not
    found", and mark it active again. No permission flag is added: the
    session runs in whatever mode the user's own Claude settings choose. Both flags must
    be set (see set_inactive/set_wake_enabled) — this must never fire for an
    agent that merely doesn't have iTerm2 open right now for some unrelated
    reason.
    """
    registry = load_json(REGISTRY_FILE, {})
    if name not in registry:
        raise HTTPException(status_code=404, detail="Agent not found")
    path = registry[name].get("path", "")
    ttys = _find_all_claude_ttys(path)
    print(f"[focus] agent={name} path={path} ttys={ttys}", flush=True)
    for tty in ttys:
        result = _focus_via_iterm(tty)
        print(f"[focus]   tty={tty} success={result['success']} stdout={result['stdout']!r}", flush=True)
        if result["success"]:
            return {"ok": True, "focused": True, "woke": False, "tty": result["tty"], "ttys_found": len(ttys)}

    with _inactive_lock:
        is_inactive = name in load_json(INACTIVE_FILE, [])
    with _wake_enabled_lock:
        wake_enabled = name in load_json(WAKE_ENABLED_FILE, [])
    if not ttys and is_inactive and wake_enabled and path:
        shell_cmd = f"cd {shlex.quote(path)} && las claude"
        result = _open_iterm_window(shell_cmd)
        if result.returncode == 0:
            with _inactive_lock:
                inactive = load_json(INACTIVE_FILE, [])
                if name in inactive:
                    inactive.remove(name)
                    save_json(INACTIVE_FILE, inactive)
            print(f"[focus] agent={name} woke via vortexia (opened new iTerm2 window)", flush=True)
            return {"ok": True, "focused": False, "woke": True, "tty": "new window", "ttys_found": 0}
        print(f"[focus] agent={name} wake failed: {result.stderr.strip()}", flush=True)

    return {"ok": True, "focused": False, "woke": False, "tty": ttys[0] if ttys else "not found", "ttys_found": len(ttys)}


@app.get("/debug/iterm_ttys")
def debug_iterm_ttys():
    """List all TTYs currently known to iTerm2 via AppleScript."""
    # `result` shadows AppleScript's own implicit `result` variable (holds
    # the value of the last executed statement) — using it as a normal list
    # broke `set end of result to ...` with "Can't set end of ... (-10006)",
    # reproduced directly via osascript. Renamed to `ttyList`.
    script = """
set ttyList to {}
tell application "iTerm2"
    repeat with w in windows
        repeat with t in tabs of w
            repeat with s in sessions of t
                set end of ttyList to (tty of s)
            end repeat
        end repeat
    end repeat
end tell
return ttyList
"""
    out = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=5)
    raw = out.stdout.strip()
    ttys = [t.strip() for t in raw.split(",") if t.strip()]
    return {"iterm_ttys": ttys, "count": len(ttys)}


def _open_iterm_window(shell_cmd: str) -> subprocess.CompletedProcess:
    """Open a new iTerm2 window running `shell_cmd`, then drop into an
    interactive login shell so the window stays open after it exits. Shared
    by open_terminal and focus_agent_terminal's wake-via-vortexia fallback —
    same osascript both callers used to build independently."""
    user_shell = os.environ.get("SHELL", "/bin/zsh")
    script = (
        'tell application "iTerm2"\n'
        f'    create window with default profile command "{user_shell} -l -c \'{shell_cmd}; exec {user_shell} -l\'"\n'
        'end tell'
    )
    return subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=10)


@app.post("/agents/{name}/terminal")
def open_terminal(name: str, body: TerminalRequest):
    """Open a new iTerm2 window running claude in the agent's directory."""
    registry = load_json(REGISTRY_FILE, {})
    if name not in registry:
        raise HTTPException(status_code=404, detail="Agent not found")
    path = registry[name].get("path", "")
    if body.resume:
        shell_cmd = f"cd {shlex.quote(path)} && las claude --resume"
    elif body.bare:
        shell_cmd = f"cd {shlex.quote(path)}"
    else:
        # `las claude`, not bare `claude`: adds the channel flag so the session
        # receives its mailbox live (cli/commands/bridge.py, docs/adr/0004).
        claude_cmd = f"las claude --model {body.model_id}" if body.model_id else "las claude"
        shell_cmd = f"cd {shlex.quote(path)} && {claude_cmd}"
    result = _open_iterm_window(shell_cmd)
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=f"osascript error: {result.stderr.strip()}")
    return {"ok": True, "model": body.model}


@app.get("/agents/{name}/ttys")
def get_agent_ttys(name: str):
    registry = load_json(REGISTRY_FILE, {})
    if name not in registry:
        raise HTTPException(status_code=404, detail="Agent not found")
    path = registry[name].get("path", "")
    return {"ttys": _find_all_claude_ttys(path)}


class TtyWriteRequest(BaseModel):
    text: str = Field(max_length=10000)
    tty:  Optional[str] = None  # write to this one TTY only; omit to write to all found


@app.post("/agents/{name}/tty-write")
def write_to_tty(name: str, body: TtyWriteRequest):
    """Type `text` directly into the agent's live iTerm2 session(s) — raw
    terminal injection via _inject_via_iterm, NOT vortexia messaging. This is
    the mechanism the widget's Clear button used (typing a literal "/clear")
    before the inter-agent inject pipeline was migrated to vortexia; that
    migration only retired cross-agent *messaging*, not this local
    "type into my own linked terminal" action, which still works exactly as
    before (mac-only, via iTerm2 AppleScript).

    An agent can have more than one live terminal open at once (see
    _find_all_claude_ttys) — with no `tty` given, this writes to ALL of them.
    """
    registry = load_json(REGISTRY_FILE, {})
    if name not in registry:
        raise HTTPException(status_code=404, detail="Agent not found")
    path = registry[name].get("path", "")
    ttys = [body.tty] if body.tty else _find_all_claude_ttys(path)
    results = [_inject_via_iterm(tty, body.text) for tty in ttys]
    written = [r["tty"] for r in results if r["success"]]
    return {"ok": True, "written": written, "ttys_found": len(ttys)}


def _resolve_targets(to: str, sessions: dict, *, session: str | None, all_sessions: bool, policy: dict) -> tuple[list, str, str | None]:
    """Which of `to`'s sessions a message goes to: (targets, mode, fallback_from).

    The sender's explicit choice wins (`session` / `all_sessions`; a choice
    nothing is connected for is a 404 — never a publish into a mailbox
    nobody will hold). Otherwise the recipient's own `sessions.target`
    applies — the same rule one level down: "default" is the agent mailbox
    (held by the last-used session), "all" fans out, a runtime or id picks
    one. A configured target that is not connected right now falls back to
    the agent mailbox (queued, never lost) and says so in `fallback_from`.
    """
    explicit = bool(session) or all_sessions
    selector = session or (TARGET_ALL if all_sessions else None) if explicit else policy["target"]
    if not selector or selector == TARGET_DEFAULT:
        return [], "direct", None
    if selector == TARGET_ALL:
        targets, mode = list(sessions.values()), "all-sessions"
    else:
        found = _resolve_session(sessions, selector)
        targets, mode = ([found] if found else []), "session"
    if targets:
        return targets, mode, None
    if explicit:
        detail = f"{to} has no connected sessions" if selector == TARGET_ALL else f"{to} has no connected session {selector!r}"
        raise HTTPException(status_code=404, detail=detail)
    return [], "direct", selector


def _kind_for(kind: str | None, target_session: dict, policy: dict) -> str | None:
    """The envelope kind for one target: the sender's, else "command" for a child that accepts nothing else."""
    if kind:
        return kind
    return KIND_COMMAND if accepts_only_commands(descriptor_for(policy, target_session.get("runtime", ""))) else None


def _route_send(*, to: str | None, scope: str | None, message: str, source: str, sender: str, session: str | None = None, all_sessions: bool = False, cc: bool = False, kind: str | None = None) -> dict:
    """Single delivery path for both /agents/send and the legacy
    /agents/{name}/inject — one implementation, two request shapes on top
    of it (DRY: this used to be duplicated between the two endpoints).

    Exactly one of `to` (point-to-point) or `scope` (broadcast, possibly
    multiple agents respond — see VortexRelayBridge._onLocalMessage's
    pickTargets in vortexia/src/vortex-relay/bridge.js) must be given; the
    caller validates that, not this function.

    - `to="Name"` — local registry lookup first (unqualified names only;
      "Name@env" always skips straight to vortex-relay, since a local
      registry entry can't be qualified). Falls back to a vortex-relay-direct
      publish (kind=vortex-relay-direct) to this environment's own gateway
      inbox when not found locally, or when explicitly qualified with
      "Name@env" to disambiguate a collision (two environments with an
      agent of the same name) — see resolveDirectoryName in
      vortexia/src/vortex-relay/directory.js.
    - `scope="free text"` — always goes through the gateway as a
      vortex-relay-intent envelope; there's no local-only equivalent of
      scope/embedding-based matching outside the bridge, so this mode
      requires VORTEXIA_ENV_NAME regardless of whether the eventual
      match(es) turn out to be local or remote. Zero, one, or several
      agents may reply — each reply is just a normal message back to the
      sender, no separate fan-in mechanism.

    Delivery is fire-and-forget in every case: a vortex-relay-direct send to
    an unresolvable name comes back as an async `vortex-relay-direct-error`
    reply to the sender, not a synchronous failure here — this can't tell
    "wrong name" apart from "right name, recipient just hasn't polled yet"
    any more than a local send ever could.

    Vortex-relay-direct/intent publishes are non-retained (unlike the local
    case): the gateway is a live, always-connected process supervised by
    launchd, not a session that polls later (see
    docs/adr/0002-service-persistence-and-logging.md) — and unlike
    `las agent listen`/poll_inbox, nothing on the bridge side clears a
    retained flag on receipt, so a retained publish here would replay into
    the bridge on every vortexia restart.

    Returns {ok, injected, mode: "direct"|"scope", relayed}. Raises
    HTTPException on a configuration error (no `to`/`scope` resolution
    possible without vortex-relay).
    """
    ts = int(time.time() * 1000)
    env_name = os.environ.get("VORTEXIA_ENV_NAME")

    if scope:
        if not env_name:
            raise HTTPException(status_code=400, detail="scope broadcast requires vortex-relay to be configured (VORTEXIA_ENV_NAME)")
        envelope = {"from": sender, "intent": scope, "text": message, "kind": "vortex-relay-intent", "ts": ts}
        delivered = _vortexia_publish(vx.inbox_topic(f"{env_name}-gateway"), envelope, retain=False)
        return {"ok": True, "injected": delivered, "mode": "scope", "relayed": True}

    registry = load_json(REGISTRY_FILE, {})
    if "@" not in to and to in registry:
        envelope = {"from": sender, "to": to, "source": source, "text": message, "ts": ts, **({"kind": kind} if kind else {})}
        policy = sessions_config(_agent_config(to, registry))
        with _sessions_lock:
            sessions = _load_sessions(to)
        targets, mode, fallback_from = _resolve_targets(to, sessions, session=session, all_sessions=all_sessions, policy=policy)
        if targets:
            # Each session has its own mailbox topic (see the sessions endpoints
            # above). A child that only understands commands (the shell) is
            # handed the text AS a command — that is what choosing it means.
            delivered = all(
                _vortexia_publish(vx.session_inbox_topic(to, s["sid"]), {**envelope, "session": s["sid"], **({"kind": k} if (k := _kind_for(kind, s, policy)) else {})}, retain=False)
                for s in targets
            )
        else:
            # Not retained: the broker's mailbox for `to` queues it if nobody is
            # connected as its consumer (see _vortexia_publish). The DEFAULT
            # session's bridge holds that mailbox (sessions above).
            delivered = _vortexia_publish(vx.inbox_topic(to), envelope, retain=False)
        # For the record: the default session (usually the intelligent one)
        # gets a copy of what went to another child — a cc, never something
        # to act on (the bridge's sinks and the las-agent skill treat kind
        # "cc" as informational).
        default_sid = _default_sid(sessions)
        cc_sent = False
        if targets and (cc or policy["cc_default"]) and all(s["sid"] != default_sid for s in targets):
            went_to = ", ".join(sorted({s.get("runtime", "?") for s in targets}))
            cc_sent = _vortexia_publish(vx.inbox_topic(to), {**envelope, "kind": "cc", "text": f"[cc → {went_to}] {message}"}, retain=False)

        # ── structured inject log (local delivery only — a vortex-relayed `to`
        # has no local registry entry, so no session/ dir to log into) ──
        path = registry.get(to, {}).get("path", "")
        log_path = Path(path) / "session" / "inject.log"
        if log_path.parent.exists():
            ts_full = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
            preview = message[:60].replace("\n", " ") + ("…" if len(message) > 60 else "")
            status  = "OK" if delivered else "FAIL(vortexia unreachable)"
            try:
                with open(log_path, "a") as f:
                    f.write(f"[{ts_full}] name={to} source={source} from={sender} via=vortexia status={status} msg={preview!r}\n")
            except OSError as exc:
                # The message is already published: a log that can't be
                # written must not turn a delivered send into a 500 (which a
                # caller would retry — and deliver twice).
                logger.warning("inject.log write failed for %s: %s", to, exc)

        # What the recipient has open, so a sender that did not pick a session
        # learns there was a choice (`las agent send` prints it when > 1).
        return {"ok": True, "injected": delivered, "mode": mode, "relayed": False, "targets": [s["sid"] for s in targets], "fallback_from": fallback_from, "cc": bool(cc_sent),
                "sessions": _session_summaries(to, sessions, policy)}

    if not env_name:
        raise HTTPException(status_code=404, detail="Agent not found (and vortex-relay not configured on this machine)")
    envelope = {"from": sender, "to": to, "source": source, "text": message, "kind": "vortex-relay-direct", "ts": ts}
    delivered = _vortexia_publish(vx.inbox_topic(f"{env_name}-gateway"), envelope, retain=False)
    return {"ok": True, "injected": delivered, "mode": "direct", "relayed": True}


@app.post("/agents/send")
def send_message(body: SendRequest):
    """Generic send: point-to-point (`to`) or scope broadcast (`scope`),
    local or cross-machine — see _route_send for the routing rules. This
    is the primitive `las agent send` calls; /agents/{name}/inject below
    is a thin backward-compatible wrapper over the same logic."""
    if bool(body.to) == bool(body.scope):
        raise HTTPException(status_code=422, detail="exactly one of `to` or `scope` must be set")
    sender = body.from_agent or body.source or "external"
    return _route_send(to=body.to, scope=body.scope, message=body.message, source=body.source, sender=sender, session=body.session, all_sessions=body.all_sessions, cc=body.cc, kind=body.kind)


@app.post("/agents/{name}/inject")
def inject_message(name: str, body: InjectRequest):
    """Send a message to `name` over vortexia. Kept for existing callers
    (every agent's las-agent skill still says `las agent inject`) — thin
    wrapper over the same _route_send logic /agents/send uses, reshaped to
    inject's original response fields for backward compatibility."""
    sender = body.from_agent or body.source or "external"
    result = _route_send(to=name, scope=None, message=body.message, source=body.source, sender=sender)
    # inject's own response shape keeps the "federated" field name for
    # backward compatibility with existing callers — only _route_send's
    # internal field was renamed to "relayed".
    return {"ok": True, "injected": result["injected"], "queued": False, "via": "vortexia", "federated": result["relayed"]}


@app.post("/agents/{name}/vortexia/register")
def vortexia_register(name: str):
    """Called by the /las-agent skill at session start. Publishes a retained
    'online' presence payload for `name` on vortexia (las/agent/<name>/presence).

    This is a one-shot publish, not a persistent VortexiaClient.register()
    connection — a freshly-invoked `las` CLI process can't stay connected for
    the life of a Claude Code session, so there's no LWT here. Presence just
    reflects "was seen recently", not "is connected right now".
    """
    registry = load_json(REGISTRY_FILE, {})
    if name not in registry:
        raise HTTPException(status_code=404, detail="Agent not found")
    ok = _vortexia_set_presence_online(name)
    return {"ok": True, "registered": ok, "via": "vortexia"}


@app.get("/agents/{name}/vortexia/poll")
def vortexia_poll(name: str, timeout: float = 2.0):
    """Drain `name`'s mailbox for up to `timeout` seconds and return whatever
    was queued. Called by the /las-agent skill at session start. Returns
    count 0 without draining when a live `las agent listen` holds the mailbox
    session (see _vortexia_poll_inbox)."""
    registry = load_json(REGISTRY_FILE, {})
    if name not in registry:
        raise HTTPException(status_code=404, detail="Agent not found")
    timeout = max(0.1, min(timeout, 10.0))
    messages = _vortexia_poll_inbox(name, timeout=timeout)
    return {"count": len(messages), "messages": messages}


# ── agent mute ────────────────────────────────────────────────────────────────

@app.post("/agents/{name}/mute")
def mute_agent(name: str):
    with _muted_lock:
        muted = load_json(MUTED_FILE, [])
        if name not in muted:
            muted.append(name)
            save_json(MUTED_FILE, muted)
    return {"ok": True, "muted": True, "name": name}


@app.delete("/agents/{name}/mute")
def unmute_agent(name: str):
    with _muted_lock:
        muted = load_json(MUTED_FILE, [])
        if name in muted:
            muted.remove(name)
            save_json(MUTED_FILE, muted)
    return {"ok": True, "muted": False, "name": name}


@app.get("/agents/{name}/muted")
def get_muted(name: str):
    with _muted_lock:
        muted = load_json(MUTED_FILE, [])
    return {"muted": name in muted, "name": name}


# ── agent inactive/active ──────────────────────────────────────────────────────
# "Inactive" marks an agent as put away — the widget's door button and
# `las agent deactivate` set this and close the widget; it does not touch the
# registry entry or kill any running Claude Code session, it's purely a
# visibility/status flag consulted by `las agents` (to list/filter) and by
# focus_agent_terminal's wake fallback below.

@app.post("/agents/{name}/inactive")
def set_inactive(name: str):
    with _inactive_lock:
        inactive = load_json(INACTIVE_FILE, [])
        if name not in inactive:
            inactive.append(name)
            save_json(INACTIVE_FILE, inactive)
    return {"ok": True, "inactive": True, "name": name}


@app.delete("/agents/{name}/inactive")
def clear_inactive(name: str):
    with _inactive_lock:
        inactive = load_json(INACTIVE_FILE, [])
        if name in inactive:
            inactive.remove(name)
            save_json(INACTIVE_FILE, inactive)
    return {"ok": True, "inactive": False, "name": name}


@app.get("/agents/{name}/inactive")
def get_inactive(name: str):
    with _inactive_lock:
        inactive = load_json(INACTIVE_FILE, [])
    return {"inactive": name in inactive, "name": name}


# ── wake-up via vortexia (opt-in per agent) ────────────────────────────────────
# When enabled, an inactive agent with no live terminal session gets woken up
# by focus_agent_terminal below instead of just reporting "not found": a new
# iTerm2 window is opened running `las claude` in
# its registered directory, and the agent is marked active again. Off by
# default — waking a session unattended is exactly the kind of thing that
# should require an explicit opt-in per agent.

@app.post("/agents/{name}/wake-enabled")
def set_wake_enabled(name: str):
    with _wake_enabled_lock:
        enabled = load_json(WAKE_ENABLED_FILE, [])
        if name not in enabled:
            enabled.append(name)
            save_json(WAKE_ENABLED_FILE, enabled)
    return {"ok": True, "wake_enabled": True, "name": name}


@app.delete("/agents/{name}/wake-enabled")
def clear_wake_enabled(name: str):
    with _wake_enabled_lock:
        enabled = load_json(WAKE_ENABLED_FILE, [])
        if name in enabled:
            enabled.remove(name)
            save_json(WAKE_ENABLED_FILE, enabled)
    return {"ok": True, "wake_enabled": False, "name": name}


@app.get("/agents/{name}/wake-enabled")
def get_wake_enabled(name: str):
    with _wake_enabled_lock:
        enabled = load_json(WAKE_ENABLED_FILE, [])
    return {"wake_enabled": name in enabled, "name": name}


# ── terminal link (drag-to-link via `las link`) ───────────────────────────────

@app.post("/agents/{name}/pin-tty")
def pin_tty(name: str, body: dict):
    """Store a TTY linked via `las link` for the widget to pick up."""
    tty = body.get("tty", "")
    if tty:
        with _pending_links_lock:
            _pending_links[name] = tty
    return {"ok": bool(tty), "tty": tty}


@app.get("/agents/{name}/pending-link")
def get_pending_link(name: str):
    """Return and clear the pending linked TTY for an agent (consumed once)."""
    from fastapi.responses import Response as FastResponse
    with _pending_links_lock:
        tty = _pending_links.pop(name, None)
    if tty:
        return {"tty": tty}
    return FastResponse(status_code=204)


# ── attribution ───────────────────────────────────────────────────────────────

@app.post("/attribution")
def record_attribution(entry: AttributionEntry):
    with _attribution_lock:
        log = load_json(ATTRIBUTION_FILE, [])
        log.append(entry.model_dump())
        save_json(ATTRIBUTION_FILE, log)
    return {"ok": True}


@app.get("/attribution")
def get_attribution(file: str = None, name: str = None):
    with _attribution_lock:
        log = load_json(ATTRIBUTION_FILE, [])
    if file:
        log = [e for e in log if e["file"] == file]
    if name:
        log = [e for e in log if e["name"] == name]
    return log


# ── widget ────────────────────────────────────────────────────────────────────

@app.get("/widget/{name}", response_class=HTMLResponse)
def widget(name: str):
    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>{name}</title>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{
    background: rgba(144,192,96,0.90);
    font-family: -apple-system, 'Helvetica Neue', Helvetica, sans-serif;
    width: 300px; height: 160px;
    display: flex; flex-direction: column;
    justify-content: center; align-items: flex-start;
    padding: 18px 24px;
    border-radius: 4px;
    overflow: hidden;
    user-select: none;
  }}
  .name {{
    font-size: 68px; font-weight: 900;
    color: #1a1a1a; line-height: 1;
    letter-spacing: -2px;
  }}
</style>
</head>
<body>
  <div class="name">{name}</div>
</body>
</html>"""
