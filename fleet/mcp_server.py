"""Fleet's stdio MCP server for Codex and Claude Code."""

from __future__ import annotations

import subprocess
import sys
from typing import Literal

from mcp.server import MCPServer

from fleet.backends import BACKENDS, installed_backends
from fleet.events import read_events
from fleet.health import clear_cooldown, cooldown_remaining, load_health
from fleet.ledger import (
    append_handoff,
    create_ledger,
    list_ledgers,
    read_ledger,
    section_of,
    update_section,
    write_ledger,
)
from fleet.models import BACKEND_IDS
from fleet.policy import load_policy
from fleet.run import dispatch, resolve_chain
from fleet.vibemin_gate import run_completion_gate
from fleet.worktree import dirty_files, ensure_worktrees, list_worktrees, slugify

MCP_VERSION = "0.2.0"
MCP_TOOL_NAMES = (
    "fleet_status",
    "fleet_task_new",
    "fleet_delegate",
    "fleet_checkpoint",
    "fleet_task_done",
    "fleet_ledger_read",
    "fleet_events",
    "fleet_route_preview",
    "fleet_clear_cooldown",
    "fleet_worktrees",
)
IMPORTANT_EVENT_TYPES = (
    "run.start",
    "run.end",
    "run.error",
    "exhausted",
    "failover",
    "permission.request",
    "vibemin.start",
    "vibemin.end",
    "vibemin.error",
)

mcp = MCPServer(
    "fleet",
    version=MCP_VERSION,
    instructions=(
        "Start with fleet_status. Keep ledgers current. A task may only become done through "
        "fleet_task_done, which enforces Vibemin."
    ),
)


@mcp.tool()
def fleet_status() -> str:
    """Show backend health, cooldowns, models, routing, and active Fleet tasks."""
    policy = load_policy()
    installed = installed_backends()
    health = load_health()
    backend_lines = []
    for backend in BACKEND_IDS:
        if backend not in installed:
            backend_lines.append(f"  {backend:<12} not installed")
        elif (remaining := cooldown_remaining(backend)) > 0:
            backend_lines.append(
                f"  {backend:<12} COOLDOWN {(remaining + 59_999) // 60_000}m — "
                f"{health.get(backend, {}).get('reason', 'unknown')}"
            )
        else:
            model = policy.get("models", {}).get(backend, {}).get("model", "backend default")
            version = BACKENDS[backend].version() if BACKENDS[backend].version else None
            version_label = f" · v{version}" if version else ""
            resolved = health.get(backend, {}).get("lastResolvedModel")
            resolved_label = f" · last resolved {resolved}" if resolved else ""
            backend_lines.append(f"  {backend:<12} ok · {model}{resolved_label}{version_label}")
    routing_lines = []
    for role in ("manage", "implement", "review", "chore"):
        chain, _ = resolve_chain(policy, role)
        routing_lines.append(f"  {role:<12} {' → '.join(chain) or 'nothing available'}")
    task_lines = [
        f"  {item.meta.id:<24} {item.meta.status:<12} "
        + (", ".join(worktree.branch for worktree in item.meta.worktrees) or "no worktree")
        for item in list_ledgers()
    ]
    backends_text = "\n".join(backend_lines)
    tasks_text = "\n".join(task_lines) or "  (none)"
    routing_text = "\n".join(routing_lines)
    return f"BACKENDS\n{backends_text}\n\nROUTING\n{routing_text}\n\nTASKS\n{tasks_text}"


@mcp.tool()
def fleet_task_new(
    id: str,
    title: str,
    project: str,
    ticket: str | None = None,
    kind: str | None = None,
    repos: list[str] | None = None,
    base: str | None = None,
) -> str:
    """Create a durable task ledger and isolated Git worktree."""
    if read_ledger(id):
        return f'Task "{id}" already exists.'
    policy = load_policy()
    ledger = create_ledger(id, title, project)
    try:
        ledger.meta.worktrees = ensure_worktrees(
            policy,
            project,
            id,
            slug=slugify(title),
            kind=kind,
            ticket=ticket,
            repos=repos,
            base=base,
        )
    except RuntimeError as error:
        return f"Ledger created at {ledger.path}, but worktree setup failed:\n{error}"
    ledger.meta.ticket = ticket
    ledger.meta.kind = kind
    ledger.meta.status = "in_progress"
    write_ledger(ledger)
    rows = "\n".join(f"  {item.branch}\n    {item.path}" for item in ledger.meta.worktrees)
    return f'Task "{id}" created.\nLedger: {ledger.path}\nWorktrees:\n{rows}'


@mcp.tool()
def fleet_delegate(
    task_id: str,
    instruction: str,
    role: Literal["manage", "implement", "review", "chore"] = "implement",
    backend: Literal["claude", "codex", "copilot", "antigravity", "mimo", "pi"] | None = None,
    read_only: bool = False,
    wait: bool = True,
    timeout_minutes: float = 20,
) -> str:
    """Delegate work to the preferred healthy coding agent for a Fleet task."""
    ledger = read_ledger(task_id)
    if not ledger:
        return f'No such task "{task_id}".'
    if not wait:
        args = [
            sys.executable,
            "-m",
            "fleet",
            "run",
            task_id,
            "--role",
            role,
            "--prompt",
            instruction,
        ]
        if backend:
            args += ["--backend", backend]
        if read_only:
            args.append("--read-only")
        subprocess.Popen(
            args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True
        )
        return f'Started {backend or role} run on "{task_id}". Poll with fleet_events.'
    result, attempts = dispatch(
        task_id,
        instruction,
        role,
        load_policy(),
        backend=backend,
        read_only=read_only,
        timeout_seconds=timeout_minutes * 60,
    )
    trail = "\n".join(
        f"  {item['backend']}: {item['outcome']}"
        + (f" ({item.get('detail')})" if item.get("detail") else "")
        for item in attempts
    )
    if not result:
        return f"No backend could take this run.\n{trail}"
    after = read_ledger(task_id)
    final_message = result.final_message[:4000] or "(none)"
    return (
        f"Ran on {result.backend} — exit {result.exit_code} in {round(result.duration_ms / 1000)}s"
        f"\n\nRouting:\n{trail}\n\nAgent's final message:\n{final_message}"
        f"\n\nCurrent state:\n{section_of(after.body if after else '', 'Current state')}"
    )


@mcp.tool()
def fleet_checkpoint(
    task_id: str,
    state: str | None = None,
    next: str | None = None,
    landmine: str | None = None,
    question: str | None = None,
    handoff: str | None = None,
    status: Literal["todo", "in_progress", "blocked"] | None = None,
) -> str:
    """Checkpoint an active task. Completion intentionally uses fleet_task_done instead."""
    ledger = read_ledger(task_id)
    if not ledger:
        return f'No such task "{task_id}".'
    changed: list[str] = []
    if state:
        update_section(task_id, "Current state", state)
        changed.append("state")
    if next:
        update_section(task_id, "Next", next)
        changed.append("next")
    if landmine:
        current = read_ledger(task_id)
        content = section_of(current.body, "Landmines") if current else ""
        update_section(task_id, "Landmines", f"{content}\n- {landmine}".strip())
        changed.append("landmine")
    if question:
        current = read_ledger(task_id)
        content = section_of(current.body, "Open questions") if current else ""
        update_section(task_id, "Open questions", f"{content}\n- {question}".strip())
        changed.append("question")
    if handoff:
        append_handoff(task_id, f"manager — {handoff}")
        changed.append("handoff")
    if status:
        current = read_ledger(task_id)
        if current:
            current.meta.status = status
            write_ledger(current)
            changed.append(f"status={status}")
    return f'Ledger "{task_id}" updated: {", ".join(changed) or "nothing"}.'


@mcp.tool()
def fleet_task_done(task_id: str) -> str:
    """Run Vibemin in every worktree, then mark the task done only if it passes."""
    ledger = read_ledger(task_id)
    if not ledger:
        return f'No such task "{task_id}".'
    gate = run_completion_gate(load_policy(), ledger)
    if not gate.ok:
        return f"Completion refused: {gate.reason}"
    current = read_ledger(task_id)
    if current:
        current.meta.status = "done"
        write_ledger(current)
    append_handoff(task_id, "marked done after mandatory Vibemin gate")
    return f'Task "{task_id}" passed Vibemin and is done.'


@mcp.tool()
def fleet_ledger_read(task_id: str) -> str:
    """Read a task's intent, state, queue, worktrees, landmines, and handoffs."""
    ledger = read_ledger(task_id)
    if not ledger:
        return f'No such task "{task_id}".'
    rows = "\n".join(
        f"  {item.branch} @ {item.path} — {len(dirty_files(item.path))} dirty file(s)"
        for item in ledger.meta.worktrees
    )
    worktree_text = rows or "  (none)"
    return (
        f"# {ledger.meta.title}\nstatus: {ledger.meta.status}\n"
        f"worktrees:\n{worktree_text}\n\n{ledger.body}"
    )


@mcp.tool()
def fleet_events(task_id: str | None = None, limit: int = 40, only_important: bool = True) -> str:
    """Read recent activity from Fleet's shared audit log."""
    types = list(IMPORTANT_EVENT_TYPES) if only_important else None
    events = read_events(task_id=task_id, types=types, limit=limit)
    return (
        "\n".join(
            f"{item['ts'][11:19]} {item['backend']:<12} {item['type']:<16} "
            f"{str(item.get('msg', ''))[:160]}"
            for item in events
        )
        or "No events."
    )


@mcp.tool()
def fleet_route_preview(
    role: Literal["manage", "implement", "review", "chore"],
    task_id: str | None = None,
    project: str | None = None,
) -> str:
    """Preview the effective project-aware backend chain and skipped backends."""
    ledger = read_ledger(task_id) if task_id else None
    chain, skipped = resolve_chain(load_policy(), role, ledger=ledger, project=project)
    skipped_text = ", ".join(f"{item['backend']} ({item['reason']})" for item in skipped) or "none"
    return (
        f'role "{role}"\n  would use: {chain[0] if chain else "NOTHING AVAILABLE"}'
        f"\n  fallback order: {' -> '.join(chain) or '(none)'}"
        f"\n  skipped: {skipped_text}"
    )


@mcp.tool()
def fleet_clear_cooldown(
    backend: Literal["claude", "codex", "copilot", "antigravity", "mimo", "pi"],
) -> str:
    """Clear a backend cooldown after its capacity or authentication recovers."""
    clear_cooldown(backend)
    return f"Cooldown cleared for {backend}."


@mcp.tool()
def fleet_worktrees(project: str) -> str:
    """List registered Git worktrees, branches, and dirty state for a project."""
    rows = [
        f"  {item.branch:<42} {len(dirty_files(item.path))} dirty  {item.path}"
        for item in list_worktrees(project)
    ]
    return "\n".join(rows) or "(none)"


def run_mcp() -> None:
    mcp.run("stdio")
