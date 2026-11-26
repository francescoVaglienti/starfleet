"""Fleet command-line interface."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import yaml

from fleet import __version__, paths
from fleet.backends import BACKENDS, installed_backends
from fleet.events import clear_mute, configure_notify, read_events, set_mute, tail_events
from fleet.health import clear_all, clear_cooldown, cooldown_remaining, load_health
from fleet.ledger import append_handoff, create_ledger, list_ledgers, read_ledger, write_ledger
from fleet.mcp_server import run_mcp
from fleet.models import BACKEND_IDS, ROLES
from fleet.policy import DEFAULT_POLICY, load_policy, model_for, save_policy, sync_all
from fleet.run import dispatch, resolve_chain
from fleet.setup import setup_host
from fleet.statusline import active_runs, render_statusline
from fleet.vibemin_gate import run_completion_gate
from fleet.worktree import (
    cleanup_task_worktrees,
    commits_ahead,
    dirty_files,
    ensure_worktrees,
    list_worktrees,
    slugify,
)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        prog="fleet",
        description="One durable task ledger for six coding backends.",
    )
    root.add_argument("--version", action="version", version=f"fleet {__version__}")
    commands = root.add_subparsers(dest="command")
    commands.add_parser("init", help="Create ~/.fleet and seed the opinionated policy")
    status = commands.add_parser("status", help="Backend health, routing, models, and active tasks")
    status.add_argument("--json", action="store_true")

    task = commands.add_parser("task", help="Create, inspect, complete, or remove tasks")
    task_commands = task.add_subparsers(dest="task_command")
    task_commands.add_parser("list")
    show = task_commands.add_parser("show")
    show.add_argument("id")
    new = task_commands.add_parser("new")
    new.add_argument("id")
    new.add_argument("--title")
    new.add_argument("--project", default=os.getcwd())
    new.add_argument("--ticket")
    new.add_argument("--kind")
    new.add_argument("--base")
    new.add_argument("--repo", action="append", dest="repos")
    done = task_commands.add_parser("done")
    done.add_argument("id")
    remove = task_commands.add_parser("rm")
    remove.add_argument("id")
    remove.add_argument("--force", action="store_true")
    remove.add_argument("--purge-ledger", action="store_true")

    for name in ("run", "delegate", "takeover"):
        run = commands.add_parser(name)
        run.add_argument("id")
        run.add_argument("--prompt")
        run.add_argument("--role", choices=ROLES)
        run.add_argument("--backend", choices=BACKEND_IDS)
        run.add_argument("--read-only", action="store_true")
        run.add_argument("--timeout", type=float, default=30, metavar="MINUTES")

    route = commands.add_parser("route")
    route.add_argument("role", choices=ROLES, nargs="?", default="implement")
    route.add_argument("--project", default=os.getcwd())
    route.add_argument("--task")
    watch = commands.add_parser("watch")
    watch.add_argument("--task")
    log = commands.add_parser("log")
    log.add_argument("--task")
    log.add_argument("-n", type=int, default=40)
    worktrees = commands.add_parser("worktrees")
    worktrees.add_argument("--project", required=True)

    policy = commands.add_parser("policy")
    policy_commands = policy.add_subparsers(dest="policy_command")
    policy_commands.add_parser("show")
    sync = policy_commands.add_parser("sync")
    sync.add_argument("--dry-run", action="store_true")
    policy_commands.add_parser("edit")

    clear = commands.add_parser("clear-cooldown")
    clear.add_argument("backend", choices=(*BACKEND_IDS, "all"))
    mute = commands.add_parser("mute")
    mute.add_argument("--hours", "-H", type=float, default=0)
    mute.add_argument("--minutes", "-M", type=float, default=0)
    commands.add_parser("unmute")
    prune = commands.add_parser("prune")
    prune.add_argument("--dry-run", action="store_true")
    prune.add_argument("--status", choices=("done", "complete"))
    setup = commands.add_parser("setup", help="Install Fleet MCP + skill into an agent host")
    setup.add_argument("host", choices=("codex", "claude", "all"))
    setup.add_argument("--dry-run", action="store_true")
    commands.add_parser("statusline", help="Render the Fleet-aware Claude status line")
    commands.add_parser("mcp", help="Run Fleet's stdio MCP server")
    return root


def _status(policy: dict[str, Any], as_json: bool = False) -> int:
    installed = installed_backends()
    health = load_health()
    if as_json:
        print(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "paths": {"events": str(paths.EVENTS), "ledgerDir": str(paths.LEDGER_DIR)},
                    "runs": active_runs(),
                    "backends": [
                        {
                            "id": backend,
                            "installed": backend in installed,
                            "model": policy.get("models", {}).get(backend, {}).get("model"),
                            "effort": policy.get("models", {}).get(backend, {}).get("effort"),
                            "lastResolvedModel": health.get(backend, {}).get("lastResolvedModel"),
                            "cooldownUntil": health.get(backend, {}).get("cooldownUntil")
                            if cooldown_remaining(backend) > 0
                            else None,
                            "reason": health.get(backend, {}).get("reason"),
                        }
                        for backend in BACKEND_IDS
                    ],
                    "routing": policy["routing"],
                    "tasks": [
                        {"id": item.meta.id, "title": item.meta.title, "status": item.meta.status}
                        for item in list_ledgers()
                    ],
                }
            )
        )
        return 0
    print("BACKENDS")
    for backend in BACKEND_IDS:
        if backend not in installed:
            print(f"  {backend:<12} not installed")
            continue
        remaining = cooldown_remaining(backend)
        if remaining:
            reason = health.get(backend, {}).get("reason", "")
            print(f"  {backend:<12} cooldown {(remaining + 59_999) // 60_000}m  {reason}")
        else:
            preference = policy.get("models", {}).get(backend, {})
            version = BACKENDS[backend].version() if BACKENDS[backend].version else None
            version_label = f" · v{version}" if version else ""
            model = preference.get("model", "backend default")
            resolved = health.get(backend, {}).get("lastResolvedModel")
            resolved_label = f" · last resolved {resolved}" if resolved else ""
            print(f"  {backend:<12} ok  {model}{resolved_label}{version_label}")
    print("\nROUTING")
    for role in ROLES:
        chain, _ = resolve_chain(policy, role)
        print(f"  {role:<12} {' → '.join(chain) or 'nothing available'}")
    print("\nTASKS")
    tasks = list_ledgers()
    if not tasks:
        print("  (none)")
    for item in tasks:
        branches = ", ".join(worktree.branch for worktree in item.meta.worktrees) or "no worktree"
        dirty = sum(
            len(dirty_files(worktree.path))
            for worktree in item.meta.worktrees
            if Path(worktree.path).exists()
        )
        dirty_text = f"  {dirty} dirty" if dirty else ""
        print(f"  {item.meta.id:<26} {item.meta.status:<12} {branches}{dirty_text}")
    return 0


def _task(args: argparse.Namespace, policy: dict[str, Any]) -> int:
    action = args.task_command or "list"
    if action == "list":
        for item in list_ledgers():
            print(f"{item.meta.id:<26} {item.meta.status:<12} {item.meta.title}")
        return 0
    if action == "show":
        ledger = read_ledger(args.id)
        if not ledger:
            print("No such task.", file=sys.stderr)
            return 1
        print(ledger.path.read_text(), end="")
        return 0
    if action == "new":
        if read_ledger(args.id):
            print(f'Task "{args.id}" already exists.', file=sys.stderr)
            return 1
        project = str(Path(args.project).expanduser().resolve())
        title = args.title or args.id
        ledger = create_ledger(args.id, title, project)
        try:
            ledger.meta.worktrees = ensure_worktrees(
                policy,
                project,
                args.id,
                slug=slugify(title),
                kind=args.kind,
                ticket=args.ticket,
                repos=args.repos,
                base=args.base,
            )
        except RuntimeError as error:
            print(f"ledger created {ledger.path}\nworktree failed: {error}", file=sys.stderr)
            return 1
        ledger.meta.ticket = args.ticket
        ledger.meta.kind = args.kind
        ledger.meta.status = "in_progress"
        write_ledger(ledger)
        print(f"created {args.id}\n  ledger {ledger.path}")
        for worktree in ledger.meta.worktrees:
            print(f"  {worktree.branch}\n    {worktree.path} (from {worktree.base})")
            if ahead := commits_ahead(worktree.repo, worktree.base):
                print(f"    warning: {ahead[0]} is {ahead[1]} commit(s) ahead of {worktree.base}")
        return 0
    ledger = read_ledger(args.id)
    if not ledger:
        print("No such task.", file=sys.stderr)
        return 1
    if action == "done":
        gate = run_completion_gate(policy, ledger)
        if not gate.ok:
            print(f"completion refused: {gate.reason}", file=sys.stderr)
            return 1
        ledger = read_ledger(args.id) or ledger
        ledger.meta.status = "done"
        write_ledger(ledger)
        append_handoff(args.id, "marked done after mandatory Vibemin gate")
        print(f"done {args.id} · Vibemin passed")
        if policy["cleanup"].get("onDone", True):
            result = cleanup_task_worktrees(policy, args.id)
            print(
                "  auto-cleaned worktrees"
                if result.get("ok")
                else f"  auto-cleanup refused: {result.get('reason')}"
            )
        return 0
    if action == "rm":
        result = cleanup_task_worktrees(policy, args.id, args.force)
        if not result.get("ok"):
            print(f"refused: {result.get('reason')}", file=sys.stderr)
            return 1
        print(f"removed worktrees for {args.id}")
        if args.purge_ledger:
            sessions = paths.pi_session_dir(args.id)
            if sessions.is_symlink():
                sessions.unlink()
            elif sessions.exists():
                shutil.rmtree(sessions)
            for log in paths.LOG_DIR.glob(f"{args.id}__*.jsonl"):
                log.unlink(missing_ok=True)
            ledger.path.unlink(missing_ok=True)
            print("  purged ledger and logs")
        return 0
    return 1


def _run(args: argparse.Namespace, policy: dict[str, Any], takeover: bool) -> int:
    ledger = read_ledger(args.id)
    if not ledger:
        print(f'No such task "{args.id}".', file=sys.stderr)
        return 1
    role = args.role or ("manage" if takeover else "implement")
    prompt = args.prompt or (
        "Continue this task from the top of the ledger's Next queue. Work until complete or "
        "genuinely blocked, and keep the ledger current."
        if takeover
        else None
    )
    if not prompt:
        print("--prompt is required.", file=sys.stderr)
        return 1
    backend = args.backend
    if takeover and not backend:
        chain, skipped = resolve_chain(policy, role, ledger=ledger)
        if not chain:
            print("Every backend is exhausted or unavailable.", file=sys.stderr)
            for item in skipped:
                print(f"  {item['backend']}: {item['reason']}", file=sys.stderr)
            return 1
        backend = chain[0]
        print(f"takeover → {backend}")
    result, attempts = dispatch(
        args.id,
        prompt,
        role,
        policy,
        backend=backend,
        read_only=args.read_only,
        timeout_seconds=args.timeout * 60,
        on_event=lambda event, message, provider: print(
            f"  {provider} · {message[:120]}" if event in {"tool.use", "run.error"} else "",
            end="\n" if event in {"tool.use", "run.error"} else "",
        ),
    )
    print("\nrouting")
    for item in attempts:
        print(f"  {item['backend']:<12} {item['outcome']} {item.get('detail', '')}")
    if not result:
        return 1
    if result.final_message.strip():
        print(f"\nfinal\n{result.final_message.strip()}")
    print(f"\nlog {result.log_path}")
    return 0 if result.exit_code == 0 and not result.failure_reason else 1


def _prune(args: argparse.Namespace, policy: dict[str, Any]) -> int:
    candidates = [
        ledger
        for ledger in list_ledgers()
        if ledger.meta.status in ({args.status} if args.status else {"done", "complete"})
    ]
    for ledger in candidates:
        if args.dry_run:
            print(f"would clean {ledger.meta.id} ({len(ledger.meta.worktrees)} worktree(s))")
            continue
        result = cleanup_task_worktrees(policy, ledger.meta.id)
        print(f"{ledger.meta.id}: {'cleaned' if result.get('ok') else result.get('reason')}")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if not args.command:
        parser().print_help()
        return 0
    if args.command == "mcp":
        run_mcp()
        return 0
    if args.command == "statusline":
        try:
            payload = json.load(sys.stdin) if not sys.stdin.isatty() else {}
        except json.JSONDecodeError:
            payload = {}
        print(render_statusline(payload if isinstance(payload, dict) else {}))
        return 0
    paths.ensure_dirs()
    policy = load_policy()
    configure_notify(policy["notify"])
    if args.command == "init":
        if not paths.POLICY.exists():
            save_policy(DEFAULT_POLICY)
        print(f"fleet initialised\n  state  {paths.FLEET_HOME}\n  policy {paths.POLICY}")
        print(f"\nBackends detected: {', '.join(installed_backends()) or 'none'}")
        print("\nNext: configure projects and Vibemin checks, then run `fleet setup all`.")
        return 0
    if args.command == "status":
        return _status(policy, args.json)
    if args.command == "task":
        return _task(args, policy)
    if args.command in {"run", "delegate", "takeover"}:
        return _run(args, policy, args.command == "takeover")
    if args.command == "route":
        ledger = read_ledger(args.task) if args.task else None
        chain, skipped = resolve_chain(policy, args.role, ledger=ledger, project=args.project)
        project = ledger.meta.repo if ledger else args.project
        print(f"role {args.role}\n  chain {' → '.join(chain) or '(none)'}")
        for backend in chain:
            preference = model_for(policy, project, backend)
            model = preference.get("model", "backend default")
            print(f"  {backend:<12} {model} {preference.get('effort', '')}")
        for item in skipped:
            print(f"  skipped {item['backend']}: {item['reason']}")
        return 0
    if args.command == "watch":
        tail_events(lambda event: print(json.dumps(event, ensure_ascii=False)), task_id=args.task)
        return 0
    if args.command == "log":
        for event in read_events(task_id=args.task, limit=args.n):
            print(
                f"{event['ts']} {event['backend']:<12} {event['type']:<16} {event.get('msg', '')}"
            )
        return 0
    if args.command == "worktrees":
        for item in list_worktrees(args.project):
            print(f"{item.branch:<42} {len(dirty_files(item.path))} dirty  {item.path}")
        return 0
    if args.command == "policy":
        if args.policy_command == "show":
            print(yaml.safe_dump(policy, sort_keys=False), end="")
            return 0
        if args.policy_command == "sync":
            for report in sync_all(policy, args.dry_run):
                state = (
                    "would change"
                    if report["changed"] and args.dry_run
                    else "changed"
                    if report["changed"]
                    else "unchanged"
                )
                print(f"{report['target']:<14} {state}  {report['path']}")
            return 0
        if args.policy_command == "edit":
            editor = shlex.split(os.environ.get("EDITOR", "vi"))
            return subprocess.call([*editor, str(paths.POLICY)])
        return 1
    if args.command == "clear-cooldown":
        clear_all() if args.backend == "all" else clear_cooldown(args.backend)
        print(f"cleared {args.backend}")
        return 0
    if args.command == "mute":
        duration = timedelta(hours=args.hours, minutes=args.minutes)
        until = (
            (datetime.now(timezone.utc) + duration).isoformat().replace("+00:00", "Z")
            if duration.total_seconds() > 0
            else None
        )
        set_mute(until)
        print(f"notifications muted until {until or 'manually unmuted'}")
        return 0
    if args.command == "unmute":
        print("notifications unmuted" if clear_mute() else "notifications were not muted")
        return 0
    if args.command == "prune":
        return _prune(args, policy)
    if args.command == "setup":
        hosts = ("codex", "claude") if args.host == "all" else (args.host,)
        code = 0
        for host in hosts:
            result = setup_host(host, dry_run=args.dry_run)
            print(f"{host}: {'ready' if result.get('ok') else 'failed'}")
            for key in ("skill", "command", "message", "statusLine", "reason"):
                if result.get(key):
                    print(f"  {result[key]}")
            code = code or (0 if result.get("ok") else 1)
        return code
    return 1


def entrypoint() -> None:
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130) from None
    except Exception as error:
        print(f"fleet: {error}", file=sys.stderr)
        raise SystemExit(1) from None
