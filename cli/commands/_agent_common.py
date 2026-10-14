"""Shared helpers for cli/commands/agents.py.

Centralizes the two pieces of logic that were previously duplicated across
multiple subcommands: resolving an agent name from the current working
directory, and inferring a locale from a TTS voice name.
"""
import json
from pathlib import Path

import click

from cli import api
from cli.path_utils import agent_config_path, find_nearest_agent_dir


def _agent_name_from_cwd():
    """Best-effort lookup of the agent name for the current directory's agent config."""
    agent_dir = find_nearest_agent_dir(Path.cwd())
    if agent_dir:
        config = agent_config_path(agent_dir)
        if config:
            try:
                return json.loads(config.read_text()).get("name")
            except Exception:
                pass
    return None


def _loose(name: str) -> str:
    """`Team Knowledge`, `team-knowledge`, `teamknowledge`: one agent."""
    return "".join(ch for ch in name.lower() if ch.isalnum())


def canonical_agent_name(name: str, registered) -> str:
    """The registry's spelling of `name` — exact first, then case/punctuation
    insensitive (an agent named after its folder gets typed as the folder).
    Unknown names come back unchanged: the caller's error says what it was
    looking for, as before."""
    if name in registered:
        return name
    matches = [r for r in registered if _loose(r) == _loose(name)]
    return matches[0] if len(matches) == 1 else name


def resolve_agent_name(name, *, err: bool = False) -> str:
    """Return `name` (in the registry's spelling) if given, else infer it from
    the agent config in the cwd.

    On failure, echoes the standard error message (matching prior per-command
    behavior) and raises SystemExit(1).
    """
    if name:
        try:
            return canonical_agent_name(name, api.get("/agents"))
        except SystemExit:   # backend unreachable: api.get already said so; keep the name typed
            return name
    resolved = _agent_name_from_cwd()
    if resolved:
        return resolved
    click.echo("Error: no agent name given and no agent config in current directory.", err=err)
    raise SystemExit(1)


def infer_locale(voice: str) -> str:
    """Return a sensible locale code for a TTS voice name."""
    try:
        return api.get(f"/voices/{voice}").get("lang", "en-US")
    except Exception:
        return "en-US"
