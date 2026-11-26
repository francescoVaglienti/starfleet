"""Backend routing, execution, failover, and durable handoff recording."""

from __future__ import annotations

import os
import queue
import subprocess
import threading
import time
import uuid
from collections.abc import Callable
from typing import Any

from fleet import paths
from fleet.backends import BACKENDS
from fleet.events import emit
from fleet.health import (
    cooldown_remaining,
    is_available,
    mark_exhausted,
    mark_failure,
    mark_success,
    record_resolved_model,
)
from fleet.ledger import append_handoff, compose_prompt, read_ledger
from fleet.models import BackendId, RunResult
from fleet.policy import application_stack_for, model_for, routing_for
from fleet.worktree import acquire_lock, release_lock


def resolve_chain(
    policy: dict[str, Any],
    role: str,
    *,
    ledger: Any = None,
    project: str | None = None,
    force: BackendId | None = None,
) -> tuple[list[BackendId], list[dict[str, str]]]:
    if force:
        return [force], []
    task_chain = ledger.meta.routing.get(role) if ledger else None
    project_path = project or (ledger.meta.repo if ledger else os.getcwd())
    raw = task_chain or routing_for(policy, project_path, role)
    chain: list[BackendId] = []
    skipped: list[dict[str, str]] = []
    for backend_id in raw:
        if backend_id not in BACKENDS:
            continue
        backend = BACKENDS[backend_id]
        if not backend.resolve():
            skipped.append({"backend": backend_id, "reason": "not installed"})
        elif not is_available(backend_id):
            minutes = max(1, (cooldown_remaining(backend_id) + 59_999) // 60_000)
            skipped.append({"backend": backend_id, "reason": f"cooling down {minutes}m"})
        else:
            chain.append(backend_id)
    return chain, skipped


def run_one(
    backend_id: BackendId,
    options: dict[str, Any],
    on_event: Callable[[str, str, BackendId], None] | None = None,
    timeout_seconds: float | None = None,
) -> RunResult:
    backend = BACKENDS[backend_id]
    binary = backend.resolve()
    if not binary:
        raise RuntimeError(f"{backend.display_name} is not installed")
    log_path = str(paths.run_log_path(options["task_id"], options["run_id"]))
    environment = {
        **os.environ,
        **(backend.env(options) if backend.env else {}),
        "FLEET_TASK": options["task_id"],
        "FLEET_RUN": options["run_id"],
    }
    started = time.monotonic()
    emit(
        {
            "runId": options["run_id"],
            "taskId": options["task_id"],
            "backend": backend_id,
            "type": "run.start",
            "msg": f"{backend.display_name} in {options['cwd']}",
            "data": {
                "cwd": options["cwd"],
                "model": options.get("model"),
                "effort": options.get("effort"),
                "readOnly": options.get("read_only", False),
            },
        },
        log_path,
    )

    process = subprocess.Popen(
        [binary, *backend.args(options)],
        cwd=options["cwd"],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    messages: queue.Queue[tuple[str, str | None]] = queue.Queue()

    def read_stream(label: str, stream: Any) -> None:
        for line in stream:
            messages.put((label, line.rstrip("\n")))
        messages.put((label, None))

    threading.Thread(target=read_stream, args=("stdout", process.stdout), daemon=True).start()
    threading.Thread(target=read_stream, args=("stderr", process.stderr), daemon=True).start()

    stdout_tail = ""
    resolved_model = ""
    stderr_tail = ""
    final_message = ""
    text_buffer = ""
    closed = 0
    timed_out = False

    def publish(parsed: dict[str, Any]) -> None:
        nonlocal final_message
        if parsed.get("type") == "agent.text" and parsed.get("msg"):
            final_message = str(parsed["msg"])
        emit(
            {
                "runId": options["run_id"],
                "taskId": options["task_id"],
                "backend": backend_id,
                **parsed,
            },
            log_path,
        )
        if on_event:
            on_event(str(parsed.get("type", "")), str(parsed.get("msg", "")), backend_id)

    while closed < 2:
        if timeout_seconds and time.monotonic() - started > timeout_seconds:
            timed_out = True
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        try:
            label, line = messages.get(timeout=0.1)
        except queue.Empty:
            continue
        if line is None:
            closed += 1
            continue
        if label == "stderr":
            stderr_tail = (stderr_tail + line + "\n")[-16_000:]
            continue
        diagnostic = backend.diagnostic_line(line) if backend.diagnostic_line else line
        if diagnostic is not None:
            stdout_tail = (stdout_tail + diagnostic + "\n")[-16_000:]
        parsed = backend.parser(line)
        if not parsed:
            continue
        data = parsed.get("data")
        if (
            backend_id == "pi"
            and isinstance(data, dict)
            and data.get("role") == "assistant"
            and isinstance(data.get("provider"), str)
            and data["provider"]
            and isinstance(data.get("model"), str)
            and data["model"]
        ):
            model = f"{data['provider']}/{data['model']}"
            if model != resolved_model:
                record_resolved_model(backend_id, model)
                resolved_model = model
        if backend.streams_text_deltas and parsed.get("type") == "agent.text":
            text_buffer += str(parsed.get("msg", ""))
            continue
        if backend.streams_text_deltas and text_buffer.strip():
            publish({"type": "agent.text", "msg": text_buffer})
            text_buffer = ""
        publish(parsed)
    exit_code = process.wait()
    if text_buffer.strip():
        publish({"type": "agent.text", "msg": text_buffer})
    combined = f"{stdout_tail}\n{stderr_tail}"
    exhaustion = None if timed_out else backend.exhaustion(combined, exit_code)
    failure_reason = (
        backend.failure(combined, exit_code)
        if not timed_out and exit_code == 0 and backend.failure
        else None
    )
    duration = int((time.monotonic() - started) * 1000)
    successful = exit_code == 0 and not failure_reason and not timed_out
    message = (
        "timed out"
        if timed_out
        else f"reported failure despite exit 0: {failure_reason}"
        if failure_reason
        else f"completed in {round(duration / 1000)}s"
        if successful
        else f"exit {exit_code}: {stderr_tail[-400:].strip()}"
    )
    emit(
        {
            "runId": options["run_id"],
            "taskId": options["task_id"],
            "backend": backend_id,
            "type": "run.end" if successful else "run.error",
            "msg": message,
            "data": {"exitCode": exit_code, "durationMs": duration, "timedOut": timed_out},
        },
        log_path,
    )
    return RunResult(
        backend_id,
        options["run_id"],
        exit_code,
        final_message,
        duration,
        exhaustion,
        log_path,
        failure_reason or ("timed out" if timed_out else None),
    )


def dispatch(
    task_id: str,
    task: str,
    role: str,
    policy: dict[str, Any],
    *,
    backend: BackendId | None = None,
    cwd: str | None = None,
    read_only: bool = False,
    timeout_seconds: float | None = None,
    on_event: Callable[[str, str, BackendId], None] | None = None,
) -> tuple[RunResult | None, list[dict[str, str]]]:
    ledger = read_ledger(task_id)
    if not ledger:
        raise RuntimeError(f'No ledger for task "{task_id}". Run: fleet task new {task_id}')
    run_cwd = cwd or (ledger.meta.worktrees[0].path if ledger.meta.worktrees else ledger.meta.repo)
    extra_dirs = [item.path for item in ledger.meta.worktrees if item.path != run_cwd]
    extra_dirs.append(str(paths.LEDGER_DIR))
    chain, skipped = resolve_chain(policy, role, ledger=ledger, force=backend)
    attempts = [{**item, "outcome": "skipped"} for item in skipped]
    if not chain:
        emit(
            {
                "runId": "-",
                "taskId": task_id,
                "backend": "fleet",
                "type": "run.error",
                "msg": "no backend available",
            }
        )
        return None, attempts
    for backend_id in chain:
        run_id = uuid.uuid4().hex[:8]
        held = acquire_lock(
            run_cwd,
            {"backend": backend_id, "runId": run_id, "taskId": task_id, "pid": os.getpid()},
        )
        if held:
            attempts.append(
                {
                    "backend": backend_id,
                    "outcome": "blocked",
                    "detail": f"worktree locked by {held.get('backend')}",
                }
            )
            break
        try:
            preference = model_for(policy, ledger.meta.repo, backend_id)
            result = run_one(
                backend_id,
                {
                    "task_id": task_id,
                    "run_id": run_id,
                    "prompt": compose_prompt(
                        ledger, task, role, application_stack_for(policy, ledger.meta.repo)
                    ),
                    "cwd": run_cwd,
                    "read_only": read_only or (backend_id == "pi" and role == "review"),
                    "extra_dirs": extra_dirs,
                    **preference,
                },
                on_event,
                timeout_seconds,
            )
            if result.exhaustion:
                mark_exhausted(backend_id, result.exhaustion)
                attempts.append(
                    {
                        "backend": backend_id,
                        "outcome": "exhausted",
                        "detail": result.exhaustion.kind,
                    }
                )
                emit(
                    {
                        "runId": run_id,
                        "taskId": task_id,
                        "backend": backend_id,
                        "type": "exhausted",
                        "msg": result.exhaustion.detail,
                    }
                )
                continue
            if result.exit_code == 0 and not result.failure_reason:
                mark_success(backend_id, result.exit_code)
                attempts.append({"backend": backend_id, "outcome": "ok"})
                seconds = round(result.duration_ms / 1000)
                handoff = f"{backend_id} ({role}) run {run_id} — exit 0 in {seconds}s"
                if result.final_message.strip():
                    handoff += f"\n\n{result.final_message.strip()}"
                append_handoff(task_id, handoff)
                return result, attempts
            mark_failure(backend_id, result.exit_code, int(policy["cooldown"]["failureMinutes"]))
            reason = result.failure_reason or f"exit {result.exit_code}"
            attempts.append({"backend": backend_id, "outcome": "failed", "detail": reason})
            append_handoff(task_id, f"{backend_id} ({role}) run {run_id} — FAILED: {reason}")
            return result, attempts
        finally:
            release_lock(run_cwd)
    return None, attempts
