from pathlib import Path
import click

SNIPPET = Path(__file__).resolve().parents[2] / "shell" / "las-shell-init.zsh"
MARKER = "# las shell-init"


def _source_line() -> str:
    return f'[ -f "{SNIPPET}" ] && source "{SNIPPET}"  {MARKER}'


@click.command("shell-init")
@click.option("--install", is_flag=True, help="Add the source line to ~/.zshrc (idempotent).")
def shell_init(install):
    """Shell integration for zsh: tints the terminal background with the agent's widget color.

    Without options, prints the snippet (`eval "$(las shell-init)"` works, but
    costs a Python start per shell). --install adds one line to ~/.zshrc that
    sources shell/las-shell-init.zsh straight from this checkout, so a
    `git pull` updates it. See the snippet's header for LAS_TINT=0 and friends.
    """
    if not install:
        click.echo(SNIPPET.read_text(), nl=False)
        return
    zshrc = Path.home() / ".zshrc"
    text = zshrc.read_text() if zshrc.exists() else ""
    kept = [l for l in text.splitlines() if not l.rstrip().endswith(MARKER)]
    kept.append(_source_line())
    zshrc.write_text("\n".join(kept) + "\n")
    click.echo(f"{zshrc}: sources {SNIPPET}. Open a new terminal (or `source ~/.zshrc`).")
