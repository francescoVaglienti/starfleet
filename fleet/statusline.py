"""Compact Fleet-aware status line shared by the Claude integration."""

from __future__ import annotations

import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from fleet import paths

DIM = "\033[2m"
YELLOW = "\033[33m"
GREEN = "\033[32m"
CYAN = "\033[36m"
RESET = "\033[0m"


def _pid_is_live(pid: Any) -> bool:
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def _minutes_since(value: Any, now: float) -> int:
    if not isinstance(value, str):
        return 0
    try:
        started = datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0
    return max(0, int((now - started) // 60))


def active_runs() -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    for lock in paths.STATE_DIR.glob("lock-*.json"):
        try:
            data = json.loads(lock.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        if not _pid_is_live(data.get("pid")):
            continue
        runs.append(
            {
                "backend": str(data["backend"]) if data.get("backend") is not None else "?",
                "taskId": str(data["taskId"]) if data.get("taskId") is not None else "?",
                "runId": str(data["runId"]) if data.get("runId") is not None else "",
                "since": data["since"] if isinstance(data.get("since"), str) else "",
                "pid": data["pid"],
            }
        )
    return sorted(runs, key=lambda item: (item["since"], item["runId"]))


def live_runs(*, now: float | None = None) -> list[tuple[str, str, int]]:
    current = time.time() if now is None else now
    return [
        (run["backend"], run["taskId"], _minutes_since(run["since"], current))
        for run in active_runs()
    ]


def _branch(cwd: Path) -> str:
    git = cwd / ".git"
    if git.is_file():
        try:
            pointer = git.read_text().split("gitdir:", 1)[1].strip()
            git = (cwd / pointer).resolve() if not Path(pointer).is_absolute() else Path(pointer)
        except (IndexError, OSError):
            return ""
    try:
        head = (git / "HEAD").read_text().strip()
    except OSError:
        return ""
    return head.rsplit("/", 1)[-1] if head.startswith("ref:") else head[:7]


def render_statusline(payload: dict[str, Any], *, now: float | None = None) -> str:
    workspace = payload.get("workspace")
    workspace = workspace if isinstance(workspace, dict) else {}
    cwd = Path(str(workspace.get("current_dir") or payload.get("cwd") or os.getcwd()))
    model_value = payload.get("model")
    model = str(model_value.get("display_name", "")) if isinstance(model_value, dict) else ""

    parts = [f"{CYAN}{cwd.name}{RESET}"]
    if branch := _branch(cwd):
        parts.append(f"{DIM}{branch}{RESET}")
    if model:
        parts.append(f"{DIM}{model}{RESET}")

    runs = live_runs(now=now)
    if runs:
        detail = ", ".join(f"{backend}:{task} {minutes}m" for backend, task, minutes in runs)
        parts.append(f"{YELLOW}⏳ fleet {len(runs)} · {detail}{RESET}")
    else:
        parts.append(f"{GREEN}● fleet idle{RESET}")
    return " │ ".join(parts)
