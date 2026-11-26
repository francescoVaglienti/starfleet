"""Install Fleet's MCP, skill, and status-line integrations."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from importlib.resources import files
from pathlib import Path
from typing import Any

from fleet import paths

CODEX_STATUS_ITEMS = (
    "model-with-reasoning",
    "project-name",
    "git-branch",
    "run-state",
    "task-progress",
    "context-remaining",
    "five-hour-limit",
    "weekly-limit",
)


def _skill_text() -> str:
    return files("fleet.resources").joinpath("fleet-skill.md").read_text()


def _write_skill(host: str, dry_run: bool) -> Path:
    root = Path.home() / (".agents" if host == "codex" else ".claude")
    destination = root / "skills" / "fleet" / "SKILL.md"
    if not dry_run:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(_skill_text())
    return destination


def _backup(path: Path) -> None:
    if not path.exists():
        return
    paths.BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).isoformat().replace(":", "-")
    shutil.copy2(path, paths.BACKUP_DIR / f"{path.name}.{stamp}.bak")


def merge_codex_statusline(config: str) -> str:
    """Merge Fleet's useful native items into Codex's existing [tui] table."""
    lines = config.splitlines()
    start = next((index for index, line in enumerate(lines) if line.strip() == "[tui]"), None)
    if start is None:
        prefix = config.rstrip()
        block = [
            "[tui]",
            f"status_line = {json.dumps(list(CODEX_STATUS_ITEMS))}",
            "status_line_use_colors = true",
        ]
        return (prefix + "\n\n" if prefix else "") + "\n".join(block) + "\n"

    end = next(
        (index for index in range(start + 1, len(lines)) if re.match(r"^\s*\[", lines[index])),
        len(lines),
    )
    status_start = next(
        (
            index
            for index in range(start + 1, end)
            if re.match(r"^\s*status_line\s*=", lines[index])
        ),
        None,
    )
    if status_start is None:
        lines.insert(start + 1, f"status_line = {json.dumps(list(CODEX_STATUS_ITEMS))}")
        end += 1
    else:
        status_end = status_start + 1
        assignment = lines[status_start]
        while assignment.count("[") > assignment.count("]") and status_end < end:
            assignment += "\n" + lines[status_end]
            status_end += 1
        existing = []
        for value in re.findall(r'"((?:\\.|[^"\\])*)"', assignment):
            try:
                existing.append(json.loads(f'"{value}"'))
            except json.JSONDecodeError:
                continue
        merged = list(dict.fromkeys([*existing, *CODEX_STATUS_ITEMS]))
        lines[status_start:status_end] = [f"status_line = {json.dumps(merged)}"]
        end += 1 - (status_end - status_start)

    if not any(
        re.match(r"^\s*status_line_use_colors\s*=", lines[index]) for index in range(start + 1, end)
    ):
        lines.insert(start + 2, "status_line_use_colors = true")
    return "\n".join(lines).rstrip() + "\n"


def _install_codex_statusline(dry_run: bool) -> str:
    target = Path.home() / ".codex" / "config.toml"
    current = target.read_text() if target.exists() else ""
    updated = merge_codex_statusline(current)
    if updated == current:
        return f"Codex status bar already configured in {target}"
    if not dry_run:
        _backup(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(updated)
    return f"{'Would configure' if dry_run else 'Configured'} Codex status bar in {target}"


def merge_claude_statusline(config: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """Install Fleet's command bar only when the user has not chosen another one."""
    if config.get("statusLine"):
        return config, False
    return {
        **config,
        "statusLine": {"type": "command", "command": "fleet statusline", "padding": 0},
    }, True


def _install_claude_statusline(dry_run: bool) -> str:
    target = Path.home() / ".claude" / "settings.json"
    if target.exists():
        try:
            current = json.loads(target.read_text())
        except json.JSONDecodeError as error:
            return (
                f"Kept invalid {target}; fix its JSON before installing "
                f"the Fleet status line ({error})"
            )
        if not isinstance(current, dict):
            return f"Kept {target}; its JSON root is not an object"
    else:
        current = {}
    updated, changed = merge_claude_statusline(current)
    if not changed:
        return f"Kept existing Claude status line in {target}"
    if not dry_run:
        _backup(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(updated, indent=2) + "\n")
    action = "Would configure" if dry_run else "Configured"
    return f"{action} Fleet-aware Claude status line in {target}"


def setup_host(host: str, *, dry_run: bool = False) -> dict[str, Any]:
    if host not in {"codex", "claude"}:
        raise ValueError("host must be codex or claude")
    binary = shutil.which(host)
    if not binary:
        return {"ok": False, "reason": f"{host} is not installed"}
    command = (
        [binary, "mcp", "add", "fleet", "--", sys.executable, "-m", "fleet", "mcp"]
        if host == "codex"
        else [
            binary,
            "mcp",
            "add",
            "fleet",
            "-s",
            "user",
            "--",
            sys.executable,
            "-m",
            "fleet",
            "mcp",
        ]
    )
    skill = _write_skill(host, dry_run)
    status_line = (
        _install_codex_statusline(dry_run)
        if host == "codex"
        else _install_claude_statusline(dry_run)
    )
    if dry_run:
        return {
            "ok": True,
            "command": " ".join(command),
            "skill": str(skill),
            "statusLine": status_line,
            "dryRun": True,
        }

    # Refresh idempotently when the host already has an older Fleet definition.
    subprocess.run([binary, "mcp", "remove", "fleet"], capture_output=True, check=False)
    process = subprocess.run(command, capture_output=True, text=True, check=False)
    if process.returncode:
        return {
            "ok": False,
            "reason": (process.stderr or process.stdout).strip(),
            "skill": str(skill),
            "statusLine": status_line,
        }
    return {
        "ok": True,
        "skill": str(skill),
        "message": (process.stdout or process.stderr).strip(),
        "statusLine": status_line,
    }
