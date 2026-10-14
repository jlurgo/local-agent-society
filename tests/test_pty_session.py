"""`las codex` runs the Codex TUI inside a PTY and types mailbox messages into it."""
import json
import os

from cli import pty_session


def test_mailbox_lines_are_pasted_into_the_tui_and_submitted_with_enter():
    inject_r, inject_w = os.pipe()
    stdin_r, stdin_w = os.pipe()
    out_r, out_w = os.pipe()
    # A stand-in TUI: read one line, echo it back tagged, exit 3.
    argv = ["/bin/sh", "-c", 'read -r line; printf "got:%s\\n" "$line"; exit 3']
    os.write(inject_w, (json.dumps({"from": "Vortexia", "source": "agent", "text": "port 9012 freed"}) + "\n").encode())
    os.close(inject_w)
    code = pty_session.run_in_pty(argv, inject_fd=inject_r, stdin_fd=stdin_r, stdout_fd=out_w)
    os.close(out_w)
    os.close(stdin_w)
    output = os.read(out_r, 65536).decode()
    assert code == 3, "the child's exit code comes back"
    assert "got:" in output and "[LAS message from Vortexia] port 9012 freed" in output
    assert "\x1b[200~" in output, "bracketed paste, so a multi-line message never submits early"


def test_human_keystrokes_are_forwarded_and_injection_names_the_mic():
    inject_r, inject_w = os.pipe()
    stdin_r, stdin_w = os.pipe()
    out_r, out_w = os.pipe()
    argv = ["/bin/sh", "-c", 'read -r a; read -r b; printf "a=%s|b=%s\\n" "$a" "$b"']
    os.write(stdin_w, b"typed by hand\r")
    os.close(stdin_w)
    os.write(inject_w, (json.dumps({"from": "Robo", "source": "human", "text": "dictated"}) + "\n").encode())
    os.close(inject_w)
    code = pty_session.run_in_pty(argv, inject_fd=inject_r, stdin_fd=stdin_r, stdout_fd=out_w)
    os.close(out_w)
    output = os.read(out_r, 65536).decode()
    assert code == 0
    assert "a=typed by hand" in output
    assert "b=" in output and "[LAS message from mic] dictated" in output


def test_format_injection_tags_agent_and_mic():
    assert pty_session.format_injection({"from": "Pulpo", "source": "agent", "text": "hi"}) == "[LAS message from Pulpo] hi"
    assert pty_session.format_injection({"from": "Me", "source": "human", "text": "hi"}) == "[LAS message from mic] hi"


def test_draft_tracker_sees_a_half_typed_line_and_its_submit():
    d = pty_session.DraftTracker()
    d.feed(b"hola qu", now=10.0)
    assert d.busy(now=10.5, quiet=1.5, max_hold=120), "a key was just pressed"
    assert d.busy(now=30.0, quiet=1.5, max_hold=120), "draft left on the line: hold"
    assert not d.busy(now=200.0, quiet=1.5, max_hold=120), "abandoned draft: stop holding"
    d.feed(b"\x1b[D\x1b[C\x7f\x7f\x7f\x7f\x7f\x7f\x7f", now=40.0)  # arrows don't count, backspaces clear
    assert not d.busy(now=42.0, quiet=1.5, max_hold=120)
    d.feed("ñandú".encode(), now=50.0)
    assert d.chars == 5, "UTF-8 counts characters, not bytes"
    d.feed(b"\r", now=51.0)
    assert not d.busy(now=53.0, quiet=1.5, max_hold=120), "Enter submitted it"


def test_a_message_arriving_mid_typing_waits_for_the_submit():
    inject_r, inject_w = os.pipe()
    stdin_r, stdin_w = os.pipe()
    out_r, out_w = os.pipe()
    argv = ["/bin/sh", "-c", 'read -r a; read -r b; printf "a=%s|b=%s\\n" "$a" "$b"']
    os.write(stdin_w, b"half typ")  # human mid-sentence, no Enter yet
    os.write(inject_w, (json.dumps({"from": "Robo", "source": "agent", "text": "ping"}) + "\n").encode())
    os.close(inject_w)
    import threading, time
    def finish():
        time.sleep(0.5)
        os.write(stdin_w, b"ed\r")
        os.close(stdin_w)
    threading.Thread(target=finish).start()
    code = pty_session.run_in_pty(argv, inject_fd=inject_r, stdin_fd=stdin_r, stdout_fd=out_w, quiet=0.1)
    os.close(out_w)
    output = os.read(out_r, 65536).decode()
    assert code == 0
    assert "a=half typed|" in output, "the message didn't splice into the human's line"
    assert "b=" in output and "[LAS message from Robo] ping" in output


def test_on_a_picker_messages_wait_until_the_human_has_chosen():
    """`codex resume` with no id opens a session picker: a message typed there
    would pick a session. With hold_until_submit nothing is typed before the
    human's first Enter — then it goes in as usual."""
    inject_r, inject_w = os.pipe()
    stdin_r, stdin_w = os.pipe()
    out_r, out_w = os.pipe()
    argv = ["/bin/sh", "-c", 'read -r a; read -r b; printf "a=%s|b=%s\\n" "$a" "$b"']
    os.write(inject_w, (json.dumps({"from": "Robo", "source": "agent", "text": "ping"}) + "\n").encode())
    os.close(inject_w)
    import threading, time
    def choose():
        time.sleep(0.6)            # the human looks at the picker, quiet for longer than `quiet`
        os.write(stdin_w, b"2\r")  # ...and picks
        os.close(stdin_w)
    threading.Thread(target=choose).start()
    code = pty_session.run_in_pty(argv, inject_fd=inject_r, stdin_fd=stdin_r, stdout_fd=out_w, quiet=0.1, hold_until_submit=True)
    os.close(out_w)
    output = os.read(out_r, 65536).decode()
    assert code == 0
    assert "a=2|" in output, "the picker got the human's choice, not the message"
    assert "a=2|b=\x1b[200~[LAS message from Robo] ping" in output, "the message went in (as a paste) right after the choice"
