"""Persistent backend cooldown and failure state."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from fleet import paths
from fleet.models import Exhaustion


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None = None) -> str:
    return (value or _now()).isoformat().replace("+00:00", "Z")


def load_health() -> dict[str, dict[str, Any]]:
    paths.ensure_dirs()
    try:
        value = json.loads(paths.HEALTH.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_health(value: dict[str, dict[str, Any]]) -> None:
    paths.ensure_dirs()
    paths.HEALTH.write_text(json.dumps(value, indent=2) + "\n")


def get_health(backend: str) -> dict[str, Any]:
    return load_health().get(backend, {"state": "ok", "consecutiveFailures": 0})


def cooldown_remaining(backend: str) -> int:
    value = get_health(backend)
    if value.get("state") != "cooldown" or not value.get("cooldownUntil"):
        return 0
    try:
        until = datetime.fromisoformat(str(value["cooldownUntil"]).replace("Z", "+00:00"))
    except ValueError:
        return 0
    return max(0, int((until - _now()).total_seconds() * 1000))


def is_available(backend: str) -> bool:
    value = get_health(backend)
    if value.get("state") != "cooldown":
        return value.get("state", "ok") == "ok"
    if cooldown_remaining(backend) <= 0:
        clear_cooldown(backend)
        return True
    return False


def mark_exhausted(backend: str, exhaustion: Exhaustion) -> None:
    health = load_health()
    previous = health.get(backend, {})
    health[backend] = {
        **previous,
        "state": "cooldown",
        "reason": f"{exhaustion.kind}: {exhaustion.detail}"[:300],
        "cooldownUntil": _iso(_now() + timedelta(milliseconds=exhaustion.retry_after_ms)),
        "lastRunAt": _iso(),
        "consecutiveFailures": int(previous.get("consecutiveFailures", 0)) + 1,
    }
    save_health(health)


def mark_success(backend: str, exit_code: int | None) -> None:
    health = load_health()
    health[backend] = {
        **{
            key: value
            for key, value in health.get(backend, {}).items()
            if key == "lastResolvedModel"
        },
        "state": "ok",
        "lastRunAt": _iso(),
        "lastExitCode": exit_code,
        "consecutiveFailures": 0,
    }
    save_health(health)


def record_resolved_model(backend: str, model: str) -> None:
    health = load_health()
    health[backend] = {
        **health.get(backend, {"state": "ok", "consecutiveFailures": 0}),
        "lastResolvedModel": model,
    }
    save_health(health)


def mark_failure(backend: str, exit_code: int | None, cooldown_minutes: int) -> None:
    health = load_health()
    previous = health.get(backend, {})
    failures = int(previous.get("consecutiveFailures", 0)) + 1
    cooling = failures >= 3
    health[backend] = {
        **previous,
        "state": "cooldown" if cooling else "ok",
        "lastRunAt": _iso(),
        "lastExitCode": exit_code,
        "consecutiveFailures": failures,
    }
    if cooling:
        health[backend]["reason"] = f"{failures} consecutive failures (exit {exit_code})"
        health[backend]["cooldownUntil"] = _iso(_now() + timedelta(minutes=cooldown_minutes))
    else:
        health[backend].pop("reason", None)
        health[backend].pop("cooldownUntil", None)
    save_health(health)


def clear_cooldown(backend: str) -> None:
    health = load_health()
    previous = health.get(backend, {})
    health[backend] = {**previous, "state": "ok"}
    health[backend].pop("reason", None)
    health[backend].pop("cooldownUntil", None)
    save_health(health)


def clear_all() -> None:
    save_health({})
