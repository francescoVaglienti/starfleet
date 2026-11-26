"""Filesystem layout for Fleet's local, user-owned state."""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import quote

HOME = Path.home()
FLEET_HOME = Path(os.environ.get("FLEET_HOME", HOME / ".fleet")).expanduser()

POLICY = FLEET_HOME / "policy.yaml"
EVENTS = FLEET_HOME / "events.jsonl"
HEALTH = FLEET_HOME / "state" / "health.json"
MANAGED = FLEET_HOME / "state" / "managed.json"
MUTE = FLEET_HOME / "state" / "mute.json"
LEDGER_DIR = FLEET_HOME / "ledger"
LOG_DIR = FLEET_HOME / "logs"
STATE_DIR = FLEET_HOME / "state"
BACKUP_DIR = FLEET_HOME / "backups"
WORKTREE_DIR = FLEET_HOME / "worktrees"

CLAUDE_SETTINGS = HOME / ".claude" / "settings.json"
CODEX_CONFIG = HOME / ".codex" / "config.toml"
CODEX_RULES = HOME / ".codex" / "rules" / "fleet.rules"
COPILOT_PERMISSIONS = HOME / ".copilot" / "permissions-config.json"


def ensure_dirs() -> None:
    for path in (FLEET_HOME, LEDGER_DIR, LOG_DIR, STATE_DIR, BACKUP_DIR, WORKTREE_DIR):
        path.mkdir(parents=True, exist_ok=True)


def ledger_path(task_id: str) -> Path:
    return LEDGER_DIR / f"{task_id}.md"


def run_log_path(task_id: str, run_id: str) -> Path:
    return LOG_DIR / f"{task_id}__{run_id}.jsonl"


def pi_session_dir(task_id: str) -> Path:
    task = quote(task_id, safe="~()*!.'-")
    return FLEET_HOME / "sessions" / "pi" / f"task-{task}"
