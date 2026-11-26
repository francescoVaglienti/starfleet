"""Unified append-only event bus and desktop notifications."""

from __future__ import annotations

import json
import os
import subprocess
import time
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from fleet import paths

_notify: dict[str, Any] = {}


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def configure_notify(config: dict[str, Any]) -> None:
    global _notify
    _notify = config


def read_mute() -> dict[str, Any] | None:
    try:
        value = json.loads(paths.MUTE.read_text())
        until = value.get("until")
        if until and datetime.fromisoformat(until.replace("Z", "+00:00")) <= datetime.now(
            timezone.utc
        ):
            paths.MUTE.unlink(missing_ok=True)
            return None
        return value if isinstance(value, dict) and value.get("since") else None
    except (OSError, ValueError, json.JSONDecodeError):
        return None


def set_mute(until: str | None) -> dict[str, Any]:
    value = {"since": now(), "until": until}
    paths.ensure_dirs()
    paths.MUTE.write_text(json.dumps(value, indent=2) + "\n")
    return value


def clear_mute() -> bool:
    active = read_mute() is not None
    paths.MUTE.unlink(missing_ok=True)
    return active


def emit(event: dict[str, Any], run_log: str | None = None) -> dict[str, Any]:
    paths.ensure_dirs()
    full = {"ts": event.get("ts", now()), **event}
    line = json.dumps(full, separators=(",", ":")) + "\n"
    with paths.EVENTS.open("a") as handle:
        handle.write(line)
    if run_log:
        with open(run_log, "a") as handle:
            handle.write(line)
    _maybe_notify(full)
    return full


def _maybe_notify(event: dict[str, Any]) -> None:
    if read_mute() or not _notify.get("command") or event.get("type") not in _notify.get("on", []):
        return
    environment = {
        **os.environ,
        "FLEET_TITLE": f"fleet · {event.get('backend')} · {event.get('taskId')}",
        "FLEET_MESSAGE": str(event.get("msg") or event.get("type"))[:240],
        "FLEET_EVENT": str(event.get("type")),
    }
    try:
        subprocess.Popen(
            ["/bin/sh", "-c", str(_notify["command"])],
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        pass


def read_events(
    *,
    task_id: str | None = None,
    backend: str | None = None,
    types: list[str] | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    if not paths.EVENTS.exists():
        return []
    output: list[dict[str, Any]] = []
    for line in paths.EVENTS.read_text().splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if task_id and event.get("taskId") != task_id:
            continue
        if backend and event.get("backend") != backend:
            continue
        if types and event.get("type") not in types:
            continue
        output.append(event)
    return output[-limit:] if limit else output


def tail_events(callback: Callable[[dict[str, Any]], None], *, task_id: str | None = None) -> None:
    paths.ensure_dirs()
    offset = paths.EVENTS.stat().st_size if paths.EVENTS.exists() else 0
    carry = ""
    while True:
        time.sleep(0.4)
        if not paths.EVENTS.exists():
            continue
        size = paths.EVENTS.stat().st_size
        if size < offset:
            offset, carry = 0, ""
        if size == offset:
            continue
        with paths.EVENTS.open() as handle:
            handle.seek(offset)
            chunk = handle.read()
        offset = size
        lines = (carry + chunk).split("\n")
        carry = lines.pop()
        for line in lines:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not task_id or event.get("taskId") == task_id:
                callback(event)
