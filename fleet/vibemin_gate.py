"""Mandatory Vibemin completion gate."""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from typing import Any

from fleet.events import emit
from fleet.ledger import append_handoff
from fleet.models import Ledger, WorktreeRef
from fleet.policy import vibemin_for


@dataclass
class GateResult:
    ok: bool
    worktree: WorktreeRef | None = None
    output: str = ""
    reason: str = ""


def _repeat(args: list[str], flag: str, values: Any) -> None:
    if isinstance(values, list):
        for value in values:
            args.extend([flag, str(value)])


def build_vibemin_args(config: dict[str, Any], worktree: WorktreeRef) -> list[str]:
    checks = config.get("checks")
    if not isinstance(checks, list) or not checks:
        raise ValueError(
            "Vibemin is required but no checks are configured. Add "
            f"projects.<path>.vibemin.checks in ~/.fleet/policy.yaml for {worktree.repo}."
        )
    args = [sys.executable, "-m", "vibemin", "--feature-base", worktree.base]
    _repeat(args, "--check", checks)
    _repeat(args, "--preserve-output", config.get("preserveOutput"))
    _repeat(args, "--final-check", config.get("finalChecks"))
    _repeat(args, "--security-check", config.get("securityChecks"))
    _repeat(args, "--test-strength-check", config.get("testStrengthChecks"))
    _repeat(args, "--dependency-check", config.get("dependencyChecks"))
    for key, flag in (
        ("allowTestChanges", "--reduce-tests"),
        ("allowDependencyChanges", "--allow-dependency-changes"),
        ("allowVisualChanges", "--allow-visual-changes"),
        ("allowUntypedTypescript", "--allow-untyped-typescript"),
    ):
        if config.get(key) is True:
            args.append(flag)
    args += ["--max-attempts", str(config.get("maxAttempts", 500))]
    args += ["--timeout", str(config.get("timeout", 300))]
    return args


def run_completion_gate(policy: dict[str, Any], ledger: Ledger) -> GateResult:
    config = vibemin_for(policy, ledger.meta.repo)
    if config.get("required", True) is False:
        return GateResult(True, output="Vibemin disabled by project policy")
    if not ledger.meta.worktrees:
        return GateResult(False, reason="Vibemin cannot run: this task has no worktrees")
    for worktree in ledger.meta.worktrees:
        try:
            args = build_vibemin_args(config, worktree)
        except ValueError as error:
            return GateResult(False, worktree, reason=str(error))
        emit(
            {
                "runId": f"vibemin-{ledger.meta.id}",
                "taskId": ledger.meta.id,
                "backend": "fleet",
                "type": "vibemin.start",
                "msg": worktree.path,
            }
        )
        process = subprocess.run(
            args, cwd=worktree.path, capture_output=True, text=True, check=False
        )
        output = (process.stdout + process.stderr).strip()
        if process.returncode:
            reason = output[-4000:] or f"Vibemin exited {process.returncode}"
            emit(
                {
                    "runId": f"vibemin-{ledger.meta.id}",
                    "taskId": ledger.meta.id,
                    "backend": "fleet",
                    "type": "vibemin.error",
                    "msg": reason,
                }
            )
            append_handoff(
                ledger.meta.id, f"Vibemin completion gate FAILED in {worktree.path}: {reason}"
            )
            return GateResult(False, worktree, output, reason)
        emit(
            {
                "runId": f"vibemin-{ledger.meta.id}",
                "taskId": ledger.meta.id,
                "backend": "fleet",
                "type": "vibemin.end",
                "msg": output[-1000:],
            }
        )
        append_handoff(
            ledger.meta.id, f"Vibemin completion gate passed in {worktree.path}: {output}"
        )
    return GateResult(True, output="Vibemin passed in every worktree")
