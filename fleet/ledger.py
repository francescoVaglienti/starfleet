"""Durable task ledgers: Fleet's cross-vendor handoff mechanism."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

import yaml

from fleet import paths
from fleet.directives import directives_for
from fleet.models import TASK_STATUSES, Ledger, LedgerMeta, WorktreeRef

FRONTMATTER = re.compile(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n?")


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def ledger_template(title: str) -> str:
    return f"""# {title}

## Why this exists
<!-- Intent and success criteria. A new agent must understand this cold. -->

## Constraints & standing directives
<!-- Non-negotiables: stack, style, boundaries, and review gates. -->

## Current state

Not started.

## Next

1. Define the first increment.

## Landmines
<!-- Append failures and traps. Never delete paid-for knowledge. -->

## Open questions
<!-- Decisions requiring a human. Flag them; do not guess. -->

## Handoffs
<!-- Append-only: who ran, what changed, and what remains. -->
"""


def _meta(task_id: str, raw: dict[str, Any]) -> LedgerMeta:
    created = str(raw.get("created") or now())
    status = raw.get("status") if raw.get("status") in TASK_STATUSES else "in_progress"
    return LedgerMeta(
        id=str(raw.get("id") or task_id),
        title=str(raw.get("title") or task_id),
        status=status,
        repo=str(raw.get("repo") or "."),
        created=created,
        updated=str(raw.get("updated") or created),
        ticket=raw.get("ticket"),
        kind=raw.get("kind"),
        worktrees=[WorktreeRef.from_dict(item) for item in raw.get("worktrees", [])],
        removed_worktrees=[WorktreeRef.from_dict(item) for item in raw.get("removedWorktrees", [])],
        routing=raw.get("routing", {}) if isinstance(raw.get("routing"), dict) else {},
    )


def read_ledger(task_id: str) -> Ledger | None:
    path = paths.ledger_path(task_id)
    if not path.exists():
        return None
    raw = path.read_text()
    match = FRONTMATTER.match(raw)
    if not match:
        return Ledger(_meta(task_id, {}), raw, path)
    metadata = yaml.safe_load(match.group(1)) or {}
    return Ledger(_meta(task_id, metadata), raw[match.end() :], path)


def write_ledger(ledger: Ledger) -> None:
    paths.ensure_dirs()
    ledger.meta.updated = now()
    metadata = yaml.safe_dump(ledger.meta.to_dict(), sort_keys=False, allow_unicode=True).rstrip()
    ledger.path.write_text(f"---\n{metadata}\n---\n\n{ledger.body.lstrip()}")


def create_ledger(task_id: str, title: str | None = None, repo: str | None = None) -> Ledger:
    timestamp = now()
    ledger = Ledger(
        LedgerMeta(
            id=task_id,
            title=title or task_id,
            status="todo",
            repo=repo or ".",
            created=timestamp,
            updated=timestamp,
        ),
        ledger_template(title or task_id),
        paths.ledger_path(task_id),
    )
    write_ledger(ledger)
    return ledger


def list_ledgers() -> list[Ledger]:
    paths.ensure_dirs()
    ledgers = [read_ledger(path.stem) for path in paths.LEDGER_DIR.glob("*.md")]
    return sorted(
        (item for item in ledgers if item), key=lambda item: item.meta.updated, reverse=True
    )


def append_handoff(task_id: str, line: str) -> None:
    ledger = read_ledger(task_id)
    if not ledger:
        return
    entry = f"- {now()} — {line}"
    if re.search(r"^##\s+Handoffs\s*$", ledger.body, re.MULTILINE):
        ledger.body = re.sub(
            r"(^##\s+Handoffs\s*$)", rf"\1\n{entry}", ledger.body, count=1, flags=re.MULTILINE
        )
    else:
        ledger.body = f"{ledger.body.rstrip()}\n\n## Handoffs\n{entry}\n"
    write_ledger(ledger)


def section_of(body: str, name: str) -> str:
    match = re.search(rf"^##\s+{re.escape(name)}\s*$([\s\S]*?)(?=^##\s+|\Z)", body, re.MULTILINE)
    return (match.group(1) if match else "").strip()


def update_section(task_id: str, section: str, content: str) -> bool:
    ledger = read_ledger(task_id)
    if not ledger:
        return False
    pattern = re.compile(
        rf"(^##[ \t]+{re.escape(section)}[ \t]*$)([\s\S]*?)(?=^##[ \t]+|\Z)", re.MULTILINE
    )
    if pattern.search(ledger.body):
        ledger.body = pattern.sub(
            lambda match: f"{match.group(1)}\n\n{content.strip()}\n\n", ledger.body, count=1
        )
    else:
        ledger.body = f"{ledger.body.rstrip()}\n\n## {section}\n\n{content.strip()}\n"
    write_ledger(ledger)
    return True


def compose_prompt(
    ledger: Ledger, task: str, role: str, application_stack: dict[str, str] | None = None
) -> str:
    directives = directives_for(ledger.meta.repo)
    directive_block = ""
    if directives:
        directive_block = (
            "\n--- STANDING DIRECTIVES (these outrank backend defaults) ---\n"
            f"{directives}\n--- END STANDING DIRECTIVES ---\n"
        )
    stack = application_stack or {}
    stack_block = ""
    if stack:
        stack_lines = "\n".join(f"- {key}: {value}" for key, value in stack.items() if value)
        stack_block = f"""
--- DEFAULT APPLICATION STACK ---
When the task asks you to build an app, site, product, or tool without specifying a stack
and the repository does not already establish one, use:
{stack_lines}
An explicit task, ledger constraint, or existing repository stack overrides this fallback.
--- END DEFAULT APPLICATION STACK ---
"""
    return f"""You are one of several coding agents working on a shared Fleet task. Your context
does not carry to the next agent; the ledger below does. Treat it as the source of truth.
{directive_block}{stack_block}
LEDGER FILE: {ledger.path}
ROLE FOR THIS RUN: {role}
REPO: {ledger.meta.repo}

--- BEGIN LEDGER ---
{ledger.body.strip()}
--- END LEDGER ---

Working agreement:
1. Read the ledger first. Respect Landmines; those failures are already paid for.
2. Do the work under YOUR TASK.
3. Before finishing, update Current state, Next, Landmines, Open questions, and Handoffs so
   an agent from another vendor can continue cold.
4. If context runs low, stop early and update the ledger before doing anything else.
5. Do not mark the task done yourself. Fleet owns completion and its mandatory Vibemin gate.

YOUR TASK:
{task}"""
