# Security

Fleet launches installed agent CLIs, Git commands, project check commands, and optional shell
notification commands with your user account. Vibemin runs the checks in your policy and can
edit the task diff. Setup and policy sync write agent configuration, with backups under
`~/.fleet/backups/`. Restart hosts yourself after reviewing saved changes.

Use trusted repositories and reviewed policy files. A worktree separates Git changes; it does
not isolate the filesystem, network, credentials, or operating system. Delegated processes
inherit the parent environment. Treat project content and agent output as untrusted data.

| Backend | Implementation | `--read-only` |
| --- | --- | --- |
| Codex | `workspace-write` with configured extra directories | Native `read-only` sandbox, approvals set to `never`, no extra writable directories; user config, rules, MCP configuration, apps and subagents disabled |
| Claude / MiMo | `bypassPermissions` | Plan mode with only `Read`, `Glob`, `Grep`; safe mode, no hooks, MCP, shell, edits, subagents or added directories |
| Copilot | All paths and tools | Plan mode with only `view`, `grep`, `glob`; shell and write permissions denied, no blanket path grant or added directories |
| Antigravity | Skips permission prompts | Plan mode with no permission bypass or added directories; headless permission requests cannot be approved |
| Pi | Caller permissions and configured tools | Only `read`, `grep`, `find`, `ls`; extensions, MCP, shell and write tools disabled |

Pi review roles also select read-only mode. For other backends, pass `--read-only` explicitly.
These restrictions apply to the delegated agent. Fleet still writes its own locks, logs,
sessions and ledger handoffs outside the source tree. Current vendor CLI flags are required;
an unsupported flag must fail the run, never trigger a retry with broader permissions.

MiMo refuses to start without a nonblank `MIMO_API_KEY`. Its child environment clears
`ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` and sets `ANTHROPIC_AUTH_TOKEN` to the supplied MiMo key.

Tool allowlists are vendor controls, not an OS sandbox. Antigravity has no tool allowlist:
its plan mode and unanswered permission prompts are the available limits. Its direct edit
tools have previously written files when plan mode was combined with permission bypass;
Fleet no longer makes that combination. Vendor bugs, trusted configuration and startup
customizations remain outside Fleet's control. Copilot's allowlist excludes plugin/MCP tools,
but does not sandbox startup hooks. Use trusted CLI installations and reviewed configuration,
or an external sandbox when filesystem isolation is required.

Read-only Claude, MiMo, Copilot and Pi cannot execute project tests or shell-based Git
commands. Supply the diff and check output from a separate trusted check runner. Antigravity
checks may be denied in headless plan mode; do not count denied checks as a passing review.
Codex can execute checks that need no filesystem writes under its native sandbox, such as
`python -B` with pytest's cache plugin disabled. Checks that create build output, caches,
snapshots or coverage files may fail: Fleet does not grant writable temp directories in this
mode. Run those checks in a disposable copy through a separately isolated check runner with
the source mounted read-only and only its temp/cache directories writable. Fleet does not
provide that runner or claim that setting cache environment variables alone isolates writes.

See the [Codex configuration reference](https://developers.openai.com/codex/config-reference),
[Claude permission modes](https://code.claude.com/docs/en/permissions), and
[Copilot tool controls](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools).

Task prompts include ledgers and applicable private directives. Providers receive these prompts
and any source content their tools read. Ledgers, logs, events, backups, and salvaged credentials
under `~/.fleet/` may contain private data. Keep that directory out of public exports. Never
put secrets in task instructions or tracked files.

Report vulnerabilities through GitHub's private vulnerability reporting for this repository
if enabled. Otherwise open an issue asking for a private reporting channel, without exploit
details or secrets. Include the affected version, backend, and a minimal reproduction only
in the private report. No dedicated security email or response-time guarantee is advertised.

The public release gate checks the current tree and package contents, not old Git history or
every possible secret format. Use the fresh export script for a new public repository and
review the result before publication. Fleet never publishes as part of that script.
