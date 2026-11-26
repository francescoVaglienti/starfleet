"""Emit the Python implementation's shared behavior contract as JSON."""

from __future__ import annotations

import copy
import json
from pathlib import Path

from fleet.backends import BACKENDS
from fleet.mcp_server import IMPORTANT_EVENT_TYPES, MCP_TOOL_NAMES, MCP_VERSION
from fleet.models import BACKEND_IDS, WorktreeRef
from fleet.policy import (
    DEFAULT_POLICY,
    application_stack_for,
    model_for,
    routing_for,
    vibemin_for,
)
from fleet.setup import CODEX_STATUS_ITEMS, merge_claude_statusline
from fleet.vibemin_gate import build_vibemin_args
from fleet.worktree import render_branch

policy = copy.deepcopy(DEFAULT_POLICY)
policy["projects"] = {
    "/tmp/acme": {
        "routing": {"implement": ["claude", "codex"]},
        "models": {
            "codex": {"model": "project-sol", "effort": "max"},
        },
        "applicationStack": {"delivery": "a tested vertical slice"},
        "vibemin": {"checks": ["pnpm test", "pnpm run typecheck"], "maxAttempts": 42},
    }
}
options = {
    "task_id": "parity",
    "run_id": "12345678",
    "prompt": "build it",
    "cwd": "/tmp/acme",
    "model": "model-x",
    "effort": "high",
    "read_only": False,
    "extra_dirs": ["/tmp/ledger"],
}
worktree = WorktreeRef("/tmp/acme", "/tmp/acme-wt", "task/demo", "main")
config = vibemin_for(policy, "/tmp/acme")

pi_contract = []
for sample in json.loads(Path("tests/fixtures/pi-contract.json").read_text()):
    lines = [json.dumps(event, ensure_ascii=False) for event in sample["events"]]
    stream = "\n".join([*lines, sample.get("stderr", "")])
    backend = BACKENDS["pi"]
    diagnostics = [line for event in lines if (line := backend.diagnostic_line(event))]
    exhaustion = backend.exhaustion(stream, sample["exitCode"])
    pi_contract.append(
        {
            "events": [event for line in lines if (event := backend.parser(line))],
            "failure": backend.failure(stream, sample["exitCode"]),
            "exhaustion": {
                "kind": exhaustion.kind,
                "retryAfterMs": exhaustion.retry_after_ms,
                "detail": exhaustion.detail,
            }
            if exhaustion
            else None,
            "diagnosticFailure": backend.failure(
                "\n".join([*diagnostics, sample.get("stderr", "")]), sample["exitCode"]
            ),
        }
    )

print(
    json.dumps(
        {
            "backendIds": list(BACKEND_IDS),
            "defaultRouting": DEFAULT_POLICY["routing"],
            "piContract": pi_contract,
            "piArgs": [
                BACKENDS["pi"].args(
                    {
                        **options,
                        "model": "provider/model:low",
                        "effort": effort,
                        "read_only": read_only,
                    }
                )
                for read_only in (False, True)
                for effort in (
                    None,
                    "none",
                    "minimal",
                    "low",
                    "medium",
                    "high",
                    "xhigh",
                    "max",
                    "ultra",
                )
            ],
            "routing": routing_for(policy, "/tmp/acme", "implement"),
            "models": {
                backend: model_for(policy, "/tmp/acme", backend)
                for backend in ("codex", "claude", "copilot", "antigravity", "mimo", "pi")
            },
            "stack": application_stack_for(policy, "/tmp/acme"),
            "branchWithTicket": render_branch(
                {"branchPattern": "{kind}/{ticket}-{slug}"},
                kind="feature",
                ticket="123",
                slug="demo-app",
            ),
            "branchWithoutTicket": render_branch(
                {"branchPattern": "{kind}/{ticket}-{slug}"},
                kind="feature",
                slug="demo-app",
            ),
            "backendArgs": {
                backend: BACKENDS[backend].args(options)
                for backend in ("codex", "claude", "copilot", "antigravity", "mimo", "pi")
            },
            "readOnlyBackendArgs": {
                backend: BACKENDS[backend].args({**options, "read_only": True})
                for backend in BACKEND_IDS
            },
            "vibeminArgs": build_vibemin_args(config, worktree)[3:],
            "integration": {
                "codexStatusItems": list(CODEX_STATUS_ITEMS),
                "claudeStatusLine": merge_claude_statusline({"theme": "dark"})[0]["statusLine"],
                "mcpVersion": MCP_VERSION,
                "mcpToolNames": list(MCP_TOOL_NAMES),
                "importantEventTypes": list(IMPORTANT_EVENT_TYPES),
            },
        },
        sort_keys=True,
    )
)
