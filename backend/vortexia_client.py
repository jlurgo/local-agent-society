"""
vortexia_client.py — thin Python client for the vortexia MQTT broker.

Mirrors the JS client's API (register/send) and adds a poll-and-collect
helper for one-shot CLI invocations that can't stay subscribed forever.

Vendored copy of vortexia's python/vortexia_client.py (sibling project at
../vortexia, synced 2026-09-23 at its commit e667707). Kept in sync by hand
since the two repos aren't packaged together — see
/Users/josetabuyo/Development/vortexia/PROTOCOL.md for the protocol. The only
LAS-only addition is resolve_mqtt_port/default_port_file_candidates (broker
port discovery); everything else must stay byte-identical to upstream.

Requires `paho-mqtt` — a real dependency of this backend, see
backend/requirements.txt.

Topic schema (see PROTOCOL.md):
    las/agent/<name>/inbox      - direct message to one agent
    las/broadcast               - message to all agents
    las/agent/<name>/presence   - retained LWT presence ("online"/"offline")
    las/agent/<name>/session    - retained, broker-published: is the
                                  mailbox consumer connected right now?

Message envelope (JSON): {id, from, to, source, text, ts}

Mailboxes (PROTOCOL.md "Mailboxes"): every inbox is backed by an MQTT
persistent session with the client id `las-agent-<name>`. Whoever connects
with that id and clean_session=False is THE consumer of that inbox: it
receives everything queued while nobody was connected, in order, and each
message is consumed by being acknowledged. A viewer (any other client id,
clean session) sees live traffic and consumes nothing. Inbox publishes are
plain QoS 1 — never retained.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Optional

try:
    import paho.mqtt.client as mqtt
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "vortexia_client requires paho-mqtt. Install it with: pip install paho-mqtt"
    ) from exc


DEFAULT_HOST = "localhost"
DEFAULT_PORT = 1883

BROADCAST_TOPIC = "las/broadcast"
MAILBOX_CLIENT_ID_PREFIX = "las-agent-"


def _pid_alive(pid) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, TypeError, ValueError):
        return False


def resolve_mqtt_port(ports: Optional[dict] = None,
                      port_file_candidates: Optional[list] = None,
                      default: Optional[int] = DEFAULT_PORT) -> Optional[int]:
    """Resolve the broker's current TCP MQTT port, mirroring vortexia's own
    client.js precedence: vortexia.port.json -> port registry -> DEFAULT_PORT.

    Why the port file comes first: vortexia claims its ports from the :8700
    registry at startup, and falls back to 1883 when the registry isn't up
    yet. On a cold boot both services are launchd jobs racing each other, so
    the broker can easily end up on 1883 while the registry still holds a
    stale claim (9014) from the previous run — every backend/CLI publish then
    goes to a port nobody listens on and vortexia is "unreachable" even
    though it's running fine (seen 2026-09-23). vortexia.port.json is written
    by the live broker *after* it binds, with its pid, so it's the
    authoritative answer whenever that pid is still alive.

    `ports` is the registry's ports.json content; `port_file_candidates` is an
    ordered list of paths to try for vortexia.port.json. Both default to what
    this checkout can see (see default_port_file_candidates()). `default` is
    returned when neither source knows a broker — pass None to be told that
    instead of getting the 1883 guess (e.g. a command that must fail soft
    rather than block on a connect to a port nobody listens on).
    """
    ports = ports or {}
    if port_file_candidates is None:
        port_file_candidates = default_port_file_candidates(ports)
    for candidate in port_file_candidates:
        try:
            data = json.loads(Path(candidate).read_text())
        except (OSError, ValueError):
            continue
        port = data.get("mqttPort")
        pid = data.get("pid")
        if port and (pid is None or _pid_alive(pid)):
            return int(port)

    claims = [info for info in ports.values() if info.get("app") == "vortexia-mqtt"]
    if claims:
        # Claims accumulate rather than get cleaned up on restart — the most
        # recently registered one is the best guess among them.
        latest = max(claims, key=lambda info: info.get("registered_at", ""))
        if latest.get("port"):
            return int(latest["port"])
    return default


def default_port_file_candidates(ports: Optional[dict] = None) -> list:
    """Where a live vortexia's port.json might be, most specific first:
    $VORTEXIA_DIR, the path recorded on its registry claim, then the sibling
    checkout next to this repo (the layout install.sh creates)."""
    dirs = []
    env_dir = os.environ.get("VORTEXIA_DIR")
    if env_dir:
        dirs.append(Path(env_dir))
    for info in (ports or {}).values():
        if str(info.get("app", "")).startswith("vortexia") and info.get("path"):
            dirs.append(Path(info["path"]))
    dirs.append(Path(__file__).resolve().parents[2] / "vortexia")
    seen, out = set(), []
    for d in dirs:
        f = d / "vortexia.port.json"
        if f not in seen:
            seen.add(f)
            out.append(f)
    return out


def inbox_topic(name: str) -> str:
    return f"las/agent/{name}/inbox"


def presence_topic(name: str) -> str:
    return f"las/agent/{name}/presence"


def session_topic(name: str) -> str:
    return f"las/agent/{name}/session"


def mailbox_client_id(name: str) -> str:
    """The MQTT client id of `name`'s mailbox session (its one consumer)."""
    return f"{MAILBOX_CLIENT_ID_PREFIX}{name}"


# ── connected sessions (docs/adr/0004, phase 2) ──────────────────────────────
# An agent may have several runtimes connected at once (a Claude session, a
# Codex session, a plain shell). Each is a *session* with its own mailbox
# topic; the agent-level inbox above keeps meaning "the agent", and is held
# by whichever session is the DEFAULT (the last one used). The backend
# publishes the default's id retained on default_session_topic so every
# bridge can see, without asking anyone, whether it should hold the agent
# mailbox right now.

def session_inbox_topic(name: str, sid: str) -> str:
    return f"las/agent/{name}/sessions/{sid}/inbox"


def session_mailbox_client_id(name: str, sid: str) -> str:
    return f"{MAILBOX_CLIENT_ID_PREFIX}{name}-{sid}"


def default_session_topic(name: str) -> str:
    return f"las/agent/{name}/default-session"


def build_envelope(from_: str, to: str, text: str, source: str = "agent") -> dict:
    return {
        "id": uuid.uuid4().hex,
        "from": from_,
        "to": to,
        "source": source,
        "text": text,
        "ts": int(time.time() * 1000),
    }


def _session_present(flags) -> bool:
    # paho 1.x hands on_connect a dict; 2.x a ConnectFlags object.
    if isinstance(flags, dict):
        return bool(flags.get("session present") or flags.get("session_present"))
    return bool(getattr(flags, "session_present", False))


class VortexiaClient:
    """
    A small paho-mqtt wrapper mirroring the JS VortexiaClient API.

    Usage:
        client = VortexiaClient(host="localhost", port=1883)
        client.register("MyAgent")                 # viewer: sees live, consumes nothing
        client.register("MyAgent", mailbox=True)   # consumer: drains the mailbox, acks each
        client.send("OtherAgent", "hello")
        client.close()
    """

    def __init__(self, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT):
        self.host = host
        self.port = port
        self.name: Optional[str] = None
        self.mailbox = False
        self.session_present = False
        self._client: Optional[mqtt.Client] = None
        self._on_message: Optional[Callable[[dict, str], None]] = None

    def register(
        self,
        name: str,
        on_message: Optional[Callable[[dict, str], None]] = None,
        mailbox: bool = False,
        presence: bool = True,
    ) -> "VortexiaClient":
        """Connect, set LWT presence, subscribe to own inbox + broadcast.

        `presence=False` skips the LWT and the online/offline publishes: for
        a short-lived connection (a one-shot poll) that must not overwrite
        the retained presence a longer-lived registration already set —
        connecting, then disconnecting, would leave the agent reading
        "offline" seconds after `las agent register` said "online".

        `mailbox=True` connects as the agent's persistent session (see the
        module docstring): the inbox subscription then belongs to the session
        and is only (re)issued when the broker reports no session present —
        the broker restores it otherwise, and creates it itself on the first
        publish to the inbox. Broadcast is subscribed at QoS 0 in mailbox
        mode: live-only, never queued for an offline agent.
        """
        self.name = name
        self.mailbox = mailbox
        self._on_message = on_message

        client_id = mailbox_client_id(name) if mailbox else f"vortexia-{name}-{uuid.uuid4().hex[:8]}"
        self.presence = presence
        client = mqtt.Client(client_id=client_id, clean_session=not mailbox, protocol=mqtt.MQTTv311)
        if presence:
            client.will_set(presence_topic(name), payload="offline", qos=1, retain=True)

        def _on_connect(c, userdata, flags, rc, *_args):
            self.session_present = _session_present(flags)
            if presence:
                c.publish(presence_topic(name), "online", qos=1, retain=True)
            if mailbox:
                subs = [(BROADCAST_TOPIC, 0)]
                if not self.session_present:
                    subs.append((inbox_topic(name), 1))
            else:
                subs = [(inbox_topic(name), 1), (BROADCAST_TOPIC, 1)]
            c.subscribe(subs)

        def _on_message(c, userdata, msg):
            try:
                envelope = json.loads(msg.payload.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return
            if self._on_message:
                self._on_message(envelope, msg.topic)

        client.on_connect = _on_connect
        client.on_message = _on_message

        client.connect(self.host, self.port, keepalive=30)
        client.loop_start()
        self._client = client
        return self

    def send(self, to: str, text: str, from_: Optional[str] = None, source: str = "agent", retain: bool = False) -> dict:
        """Publish a direct message (or 'broadcast' to reach everyone).

        Plain QoS 1, not retained: the broker queues it in the recipient's
        mailbox if its consumer isn't connected. `retain=True` is the legacy
        single-slot behaviour (the latest message overwrites the rest) —
        only for a caller that knowingly wants it. Broadcast is never
        retained.
        """
        if not self._client:
            raise RuntimeError("client not registered — call register(name) first")
        envelope = build_envelope(from_ or self.name, to, text, source)
        is_broadcast = to == "broadcast"
        topic = BROADCAST_TOPIC if is_broadcast else inbox_topic(to)
        self._client.publish(topic, json.dumps(envelope), qos=1, retain=retain and not is_broadcast)
        return envelope

    def close(self) -> None:
        if not self._client:
            return
        if self.name and getattr(self, "presence", True):
            self._client.publish(presence_topic(self.name), "offline", qos=1, retain=True)
            time.sleep(0.1)  # give the publish a moment to flush before disconnecting
        self._client.loop_stop()
        self._client.disconnect()
        self._client = None


def session_state(name: str, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT, timeout: float = 0.7) -> dict:
    """
    Is `name`'s mailbox session held by a live connection right now? Reads
    the retained, broker-published `las/agent/<name>/session` topic with a
    throwaway clean client. Returns {"connected": bool, ...}; "connected" is
    False when the broker has never seen that mailbox.
    """
    state: dict = {"connected": False}
    got = []

    client = mqtt.Client(client_id=f"vortexia-session-{uuid.uuid4().hex[:8]}", clean_session=True, protocol=mqtt.MQTTv311)

    def _on_connect(c, userdata, flags, rc, *_args):
        c.subscribe(session_topic(name), qos=0)

    def _on_message(c, userdata, msg):
        try:
            data = json.loads(msg.payload.decode("utf-8"))
            state.update({"connected": bool(data.get("connected")), "clientId": data.get("clientId"), "ts": data.get("ts")})
        except (ValueError, UnicodeDecodeError):
            pass
        got.append(True)

    client.on_connect = _on_connect
    client.on_message = _on_message
    client.connect(host, port, keepalive=10)
    client.loop_start()
    deadline = time.time() + timeout
    while not got and time.time() < deadline:
        time.sleep(0.02)
    client.loop_stop()
    client.disconnect()
    return state


def publish_watching(topic: str, envelope: dict, watch_topic: str, matches, host: str = DEFAULT_HOST,
                     port: int = DEFAULT_PORT, timeout: float = 1.5) -> Optional[dict]:
    """Publish `envelope` to `topic`, then listen on `watch_topic` for up to
    `timeout` seconds and return the first envelope `matches(env)` accepts,
    or None. A plain clean client, subscribed BEFORE the publish so a fast
    answer can't be missed; it only listens, so the mailbox consumer of
    `watch_topic` still gets everything as usual."""
    found: list = []
    subscribed = threading.Event()
    client = mqtt.Client(client_id=f"vortexia-watch-{uuid.uuid4().hex[:8]}", clean_session=True, protocol=mqtt.MQTTv311)

    def _on_connect(c, userdata, flags, rc, *_args):
        c.subscribe(watch_topic, qos=1)

    def _on_subscribe(c, *_args):
        subscribed.set()

    def _on_message(c, userdata, msg):
        try:
            env = json.loads(msg.payload.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return
        if isinstance(env, dict) and matches(env):
            found.append(env)

    client.on_connect = _on_connect
    client.on_subscribe = _on_subscribe
    client.on_message = _on_message
    client.connect(host, port, keepalive=10)
    client.loop_start()
    try:
        subscribed.wait(timeout)
        client.publish(topic, json.dumps(envelope), qos=1).wait_for_publish(timeout)
        deadline = time.time() + timeout
        while not found and time.time() < deadline:
            time.sleep(0.02)
    finally:
        client.loop_stop()
        client.disconnect()
    return found[0] if found else None


def poll_inbox(
    name: str,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    timeout: float = 2.0,
    takeover: bool = False,
) -> list[dict]:
    """
    Connect as `name`'s mailbox consumer just long enough to drain whatever
    is queued (plus anything arriving during `timeout`), then disconnect.
    Each message is consumed by being acknowledged, so a second poll does
    not see it again. Useful for a CLI tool invoked fresh each time, which
    can't stay subscribed indefinitely.

    If a live consumer already holds the session (a `las agent listen`
    running under the agent's Monitor), returns [] WITHOUT connecting as the
    mailbox: taking the session over would kick that listener, and with a
    reconnecting listener the two would keep kicking each other. That
    listener IS the delivery path while it runs. `takeover=True` insists.
    """
    if not takeover and session_state(name, host=host, port=port).get("connected"):
        return []

    collected: list[dict] = []

    def _on_message(envelope: dict, topic: str) -> None:
        if topic == inbox_topic(name):
            collected.append(envelope)

    client = VortexiaClient(host=host, port=port)
    client.register(name, on_message=_on_message, mailbox=True, presence=False)
    time.sleep(timeout)
    client.close()
    return collected
