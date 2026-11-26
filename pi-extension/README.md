# pi-fleet

Fleet orchestration inside Pi, with live activity above the editor.

```text
codex   checkout-flow   2m 14s   tool.call pnpm test
claude  login-fix       43s      agent.text Checking the redirect
─────────────────────────────────────────────────────────────────
> Ask Pi to delegate, review, or resume a task
─────────────────────────────────────────────────────────────────
fleet 2 running · codex:checkout-flow 2m 14s, claude:login-fix 43s
```

## Install

Requires Node 22+, Pi 1.5.2+, and `fleet` on PATH. Install Fleet with
`pnpm add -g fleet-ai` or `uv tool install fleet-ai`. Live activity requires
a Fleet build supporting `fleet status --json` (schema 1).

Once published:

```sh
pi install npm:pi-fleet
```

Or install this repository from a ref containing the extension:

```sh
pi install git:github.com/francescoVaglienti/starfleet
```

The root package declares the extension and canonical Fleet skill for git installs.
The standalone npm package copies that same skill at build time. Start a new Pi
session after installing. No running app is reloaded by the package.

## What you see

- The footer says `fleet idle`, or lists each running backend, task and elapsed time,
  followed by backend cooldowns. Process locks remove crashed runs on the next refresh.
- The widget shows the latest event for each run, following new log bytes every 400 ms.
  Status and cooldowns refresh every five seconds. Rotation, truncation and partial UTF-8
  writes are handled. It starts at the current log offset.
- `/fleet` chooses a task; `/fleet <task>` opens it directly. The live overlay includes
  all retained events for that task and its ledger's **Current state** and **Next**.
  Arrow keys and Page Up/Down scroll; Home shows the ledger; End follows new events;
  Escape closes. The overlay reads history once, then follows appended bytes.
- `/fleet status` prints Fleet's full status. Delegations have readable transcript
  headers; expand a tool result to see its full output.

All ten Fleet tools are registered with their installed schemas: `fleet_status`,
`fleet_task_new`, `fleet_delegate`, `fleet_checkpoint`, `fleet_ledger_read`,
`fleet_events`, `fleet_route_preview`, `fleet_task_done`, `fleet_worktrees`, and
`fleet_clear_cooldown`. Calls run the installed `fleet mcp` executable; routing,
worktrees, background runs and the completion gate remain Fleet's responsibility.

| Pi mode | Tools | Status / widget | Task overlay |
| --- | --- | --- | --- |
| Interactive TUI | Yes | Yes | Yes |
| RPC | Yes | Extension UI records | Text status fallback |
| Print / JSON | Yes | No UI calls | Status on stderr / JSON messages |

## State and safety

Fleet's CLI resolves all state paths, including `FLEET_HOME`. Nothing is uploaded
by the view. Agent execution has Fleet's normal permissions. Log and ledger text is
treated as data; terminal control codes are removed before display. The overlay
retains the selected task's history in memory while open; archived log files are not
searched. Tool output retains Fleet's own limits. Prefer `wait: false` for long
delegations. Cancelling a waiting delegation stops Pi's wait; Fleet keeps working
with its worktree lock held. Follow it with `/fleet` or `fleet_events`.

## Develop

From the repository root:

```sh
pnpm install
pnpm build
uv sync
pnpm --dir pi-extension install
pnpm --dir pi-extension build
pnpm --dir pi-extension typecheck
PATH="$PWD/bin:$PATH" pnpm --dir pi-extension test
PATH="$PWD/bin:$PATH" pi -e ./pi-extension/index.ts
```

Tests use real Fleet and Pi subprocesses with temporary state, without model auth.
`pnpm --dir pi-extension pack` creates the standalone npm tarball; it does not publish.
