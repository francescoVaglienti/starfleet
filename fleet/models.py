"""Shared Fleet data types."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

BackendId = Literal["claude", "codex", "copilot", "antigravity", "mimo", "pi"]
Role = Literal["manage", "implement", "review", "chore"]
TaskStatus = Literal["todo", "in_progress", "blocked", "done", "complete"]

BACKEND_IDS: tuple[BackendId, ...] = ("claude", "codex", "copilot", "antigravity", "mimo", "pi")
ROLES: tuple[Role, ...] = ("manage", "implement", "review", "chore")
TASK_STATUSES: tuple[TaskStatus, ...] = ("todo", "in_progress", "blocked", "done", "complete")


@dataclass
class WorktreeRef:
    repo: str
    path: str
    branch: str
    base: str
    head: str | None = None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> WorktreeRef:
        return cls(**{key: value.get(key) for key in ("repo", "path", "branch", "base", "head")})

    def to_dict(self) -> dict[str, Any]:
        return {key: value for key, value in asdict(self).items() if value is not None}


@dataclass
class LedgerMeta:
    id: str
    title: str
    status: TaskStatus
    repo: str
    created: str
    updated: str
    ticket: str | None = None
    kind: str | None = None
    worktrees: list[WorktreeRef] = field(default_factory=list)
    removed_worktrees: list[WorktreeRef] = field(default_factory=list)
    routing: dict[str, list[str]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "id": self.id,
            "title": self.title,
            "status": self.status,
            "repo": self.repo,
            "created": self.created,
            "updated": self.updated,
        }
        if self.ticket:
            value["ticket"] = self.ticket
        if self.kind:
            value["kind"] = self.kind
        if self.worktrees:
            value["worktrees"] = [item.to_dict() for item in self.worktrees]
        if self.removed_worktrees:
            value["removedWorktrees"] = [item.to_dict() for item in self.removed_worktrees]
        if self.routing:
            value["routing"] = self.routing
        return value


@dataclass
class Ledger:
    meta: LedgerMeta
    body: str
    path: Path


@dataclass
class Exhaustion:
    kind: str
    retry_after_ms: int
    detail: str


@dataclass
class RunResult:
    backend: BackendId
    run_id: str
    exit_code: int | None
    final_message: str
    duration_ms: int
    exhaustion: Exhaustion | None
    log_path: str
    failure_reason: str | None = None
