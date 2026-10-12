import click
from cli.commands.system import status, start_cmd, stop_cmd, restart_cmd, logs, install, uninstall, update
from cli.commands.speak import speak
from cli.commands.agents import agent, agents_list, link, widget, widgets_all
from cli.commands.ports import ports
from cli.commands.voices import voices
from cli.commands.queue import queue
from cli.commands.boarding import boarding
from cli.commands.completion import completion
from cli.commands.shell_init import shell_init
from cli.commands.bridge import bridge, claude_cmd, codex_cmd, shell_cmd


@click.group()
def cli():
    """Local Agent Society — CLI.

    If the current directory has a .las-agent.json, you are a local agent of this society. Load the
    `/las-agent` skill before doing anything else — it covers how to speak
    (`las speak`), how to talk to other agents on this machine or another
    one (`las agent send`), how the widget works, and what's expected of
    you as a member of the society. Don't rediscover any of this from the
    command tree; it's already documented there.
    """


cli.add_command(status)
cli.add_command(start_cmd, name="start")
cli.add_command(stop_cmd, name="stop")
cli.add_command(restart_cmd, name="restart")
cli.add_command(logs)
cli.add_command(install)
cli.add_command(uninstall)
cli.add_command(update)
cli.add_command(speak)
cli.add_command(agents_list, name="agents")
cli.add_command(agent)
cli.add_command(widget)
cli.add_command(widgets_all, name="widgets")
cli.add_command(link)
cli.add_command(ports)
cli.add_command(voices)
cli.add_command(queue)
cli.add_command(boarding)
cli.add_command(completion)
cli.add_command(bridge)
cli.add_command(claude_cmd, name="claude")
cli.add_command(codex_cmd, name="codex")
cli.add_command(shell_cmd, name="shell")
cli.add_command(shell_init, name="shell-init")
