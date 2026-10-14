# ADR 0002 — Service persistence and logging for backend + vortexia

## Status

Accepted (macOS implementation). Linux/Windows are future work — see below.

## Context

On 2026-09-14, the "System" agent's mic self-test failed: vortexia briefly
refused connections (`Connection refused`, `Errno 61`) for several agents at
once, then recovered on its own a minute later. Investigating turned up two
separate gaps:

1. **No diagnostic trail.** Neither vortexia nor the backend kept enough of
   a log to reconstruct what happened during the blip — vortexia had no log
   file at all, and the backend's `backend.log` only held whatever ad-hoc
   `print()` calls happened to fire, in an unbounded, unrotated file.
2. **No real persistence.** vortexia has never been anything but a process
   someone starts by hand from its own repo — if it dies, nothing brings it
   back, and nothing survives a reboot. The backend *did* have a launchd
   LaunchAgent (`com.localagent.system`, added in `install.sh`), but it was
   silently broken: `backend/serve.sh` never set `PYTHONPATH`, so the
   launchd-managed process crashed on import every time (`main.py` imports
   `cli.path_utils` at module level) and stayed in `launchd`'s throttled
   crash-loop indefinitely, while the actually-serving backend was really
   just whatever someone had started manually via `start.sh`. Persistence
   existed on paper, not in practice.

## Decision

### Logging

Both processes get an app-level daily-rotating log, independent of the OS:

- vortexia: `vortexia/src/logger.js` — no new dependency, rotates
  `logs/vortexia.log` → `logs/vortexia.log.YYYY-MM-DD` at the first write of
  a new day, prunes files older than 7 days. Wired into `aedes` connection
  events (`client`, `clientDisconnect`, `clientError`, `connectionError`)
  and process-level `uncaughtException`/`unhandledRejection` handlers that
  log the cause before exiting — a supervisor can only restart a process
  that actually exits.
- backend: `backend/logging_config.py` — same 7-day contract via Python's
  `TimedRotatingFileHandler`, writing `logs/backend.log` (or
  `$LAS_BACKEND_LOG_DIR/backend.log` — the test suite sets it so a
  TestClient never writes into the production log). The existing
  vortexia-connectivity warnings in `main.py` now go through this logger
  instead of bare `print()`.

Both keep a *separate* raw `logs/launchd.{out,err}.log` per process, fed by
the OS supervisor's stdout/stderr capture — this is what catches a crash
before the app-level logger initializes (missing dependency, syntax error),
which the app-level logger can't see by definition.

### Persistence (macOS: launchd)

Both processes run as per-user `launchd` LaunchAgents:

- `com.localagent.system` (backend) — plist generated inline by
  `install.sh`; fixed to actually set `PYTHONPATH` and install full
  `requirements.txt` in `serve.sh`.
- `com.localagentsociety.vortexia` — `vortexia/launchd/*.plist.template` +
  `vortexia/scripts/install-service.sh`/`uninstall-service.sh`, invoked from
  `install.sh` if `../vortexia` exists as a sibling repo.

Both use the same restart contract: `RunAtLoad=true`,
`KeepAlive.SuccessfulExit=false` (restart on crash, not after a clean
stop), `ThrottleInterval=10`. `launchd` itself is what survives sleep/wake
and reboot — no extra wake-handling code needed; a LaunchAgent registered
this way is simply re-evaluated by launchd whenever the user session comes
back.

This does **not** cover `widget-electron` — the GUI app is deliberately
launched via `las widget`'s destroy-then-recreate flow (see CLAUDE.md §8,
"one widget, reopen not focus"), and adding an OS supervisor there would
fight that invariant. Persistence here is scoped to the two headless
services agents actually depend on to communicate.

## Cross-platform plan (not yet implemented)

The contract each platform's installer must satisfy, so vortexia and the
backend behave identically regardless of OS:

| Requirement | macOS (done) | Linux (future) | Windows (future) |
|---|---|---|---|
| Start at login/boot | launchd `RunAtLoad` | systemd `--user` unit, `WantedBy=default.target` | Task Scheduler, trigger "At log on" |
| Restart on crash | launchd `KeepAlive.SuccessfulExit=false` | systemd `Restart=on-failure` | Task Scheduler "restart on failure" action, or run as an NSSM-wrapped service |
| Survive sleep/wake | free (launchd re-evaluates the job) | free (systemd user session persists) | Task Scheduler trigger conditions must explicitly allow "wake the computer" / not stop on battery |
| Daily rotated logs, 7-day retention | `vortexia/src/logger.js`, `backend/logging_config.py` (already OS-agnostic — reused as-is) | same | same |
| Install/uninstall entrypoint | `vortexia/scripts/install-service.sh` / `uninstall-service.sh`, `install.sh` | mirror: `install-service.sh` writing a `.service` unit + `systemctl --user enable --now` | mirror: a `.ps1` registering the scheduled task |

The app-level logging code needs no changes to port — it's plain Node/Python
file I/O. Only the *supervisor* layer (the plist/unit/task) is
OS-specific, and each new platform should add its own
`scripts/install-service.sh` (or `.ps1`) following this same contract
rather than a shared abstraction layer — there's no cross-platform service
API worth building for two processes.

## Consequences

- Diagnosing a future incident like the one on 2026-09-14 now has an actual
  log to read for both processes, not just whatever happened to be
  redirected to stdout at the time.
- The backend's launchd job needs a one-time cutover: the process currently
  serving `:8700` was started manually (`start.sh`, unmanaged), not by the
  fixed `serve.sh`/launchd job. Handing off requires briefly stopping and
  restarting the backend (and, separately, vortexia) — done deliberately,
  not as a side effect of this ADR landing.
- `las start`'s existing "already running" port check means it won't fight
  a launchd-managed backend once the cutover happens.

## Addendum 2026-10-14 — one way in: `backend/service.sh`

The last consequence above did not hold. `las start` / `las restart`
(`start.sh`, `restart-widget.sh`) still called `backend/start.sh`, which
spawns uvicorn by hand whenever `:8700` is free. Any stop-then-start
therefore replaced the supervised backend with an unsupervised one, and the
launchd job then died on `[Errno 48] address already in use` until someone
noticed: seen 2026-09-14 and again 2026-09-28 (301 failed runs). It was
dodged by hand once more on 2026-10-14.

Decision: **`backend/service.sh start|stop|restart|status` is the only entry
point**, and every script goes through it:

| Caller | Before | Now |
|---|---|---|
| `start.sh` (`las start`, `update.sh`) | `backend/start.sh` (manual uvicorn) | `service.sh start` |
| `stop.sh` (`las stop`, `restart-widget.sh`) | kill the pid file / whatever holds :8700 | `service.sh stop` |
| `backend/start.sh`, `backend/stop.sh` run by hand | manual process | hand over to `service.sh` when the LaunchAgent exists; `--manual` for the old behaviour |

With the LaunchAgent installed, `service.sh` only uses `launchctl`:

- `start`: `bootstrap` if the job isn't loaded, `kickstart` if it's loaded but idle.
- `stop`: `bootout`. The backend stays stopped until `start` or the next login.
- `restart`: `kickstart -k`.

Before any of these it removes a stray, meaning a process listening on the
port that is not the job's pid, and deletes `backend.pid`. Without the
LaunchAgent (not installed, or not macOS) it falls back to the manual
scripts, so Windows and Linux behave exactly as before until they get their
own supervisor.

Tests: `tests/test_backend_service.py` runs the real script against a fake
`launchctl` that keeps the job state and listens on the port. It also runs
a real stray listener, and checks that no top-level script calls
`backend/start.sh` anymore.
