# Contributing

Run a live read-only check with `uv run python -m scripts.probe_read_only <backend>`.
It uses your CLI credentials and quota, asks the agent to modify a disposable tracked file,
then records the result and Git status in a temporary directory. Exit 1 means a mutation;
exit 2 means the backend was unavailable or did not complete. A clean tree after a failed
startup is not proof that the backend enforced read-only mode.

Use Node 22+, pnpm, Python 3.10+, uv, and Git. Work on a feature branch in a separate worktree.

```sh
pnpm install --frozen-lockfile
uv sync --frozen
pnpm test
.venv/bin/python -m pytest -q
uv run ruff check fleet tests scripts
uv run ruff format --check fleet tests scripts
```

Behavior changes must cover both `src/` and `fleet/`. Keep versions, policy defaults, backend
arguments, MCP contracts, and shared state formats aligned. Keep `skill/SKILL.md` and
`fleet/resources/fleet-skill.md` identical. The Node suite executes the Python parity probe;
install both runtimes before testing.

Test real behavior end to end. Add focused unit coverage for observed regressions, not copies
of the implementation. Use clear names instead of explanatory comments or docstrings; keep
required machine directives and executable tool descriptions. Use temporary `FLEET_HOME` and
home directories for tests so personal policy and running hosts are untouched.

Before release:

```sh
npm pack --dry-run
uv build --out-dir py-dist
sh scripts/check-public.sh
sh scripts/export-public.sh /tmp/fleet-public-export
```

The gate requires pnpm, npm, uv, Python, and installed Node dependencies. It builds packages
with npm lifecycle scripts disabled internally to avoid recursive `prepack` calls. Public
patterns are generic; put private project names and domains in the ignored `.private-denylist`
in the main checkout. See the README for lookup precedence and CI configuration. Never add
private patterns, real home paths, personal email addresses, or credentials to test fixtures.

The export target must not exist. Stage intended new files first; the script copies tracked
working files and creates a single fresh commit only after package checks pass. It does not
push. Registry publication and package-name ownership are separate release decisions.

Include the checks you ran and known failures in the pull request. Fleet-managed tasks need
a review from another model family and one final Vibemin consolidation gate before completion.
