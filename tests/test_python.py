from __future__ import annotations

import copy
import io
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from fleet.backends import BACKENDS
from fleet.cli import main
from fleet.ledger import compose_prompt, create_ledger, read_ledger, update_section
from fleet.mcp_server import MCP_TOOL_NAMES, mcp
from fleet.models import BACKEND_IDS, Ledger, LedgerMeta, WorktreeRef
from fleet.policy import (
    DEFAULT_POLICY,
    application_stack_for,
    model_for,
    routing_for,
    vibemin_for,
)
from fleet.setup import merge_claude_statusline, merge_codex_statusline, setup_host
from fleet.statusline import render_statusline
from fleet.vibemin_gate import build_vibemin_args, run_completion_gate
from fleet.worktree import render_branch, slugify


def test_project_preferences_override_global_defaults() -> None:
    policy = copy.deepcopy(DEFAULT_POLICY)
    policy["projects"] = {
        "/tmp/example": {
            "routing": {"implement": ["claude", "codex"]},
            "models": {"codex": {"model": "project-sol", "effort": "max"}},
            "applicationStack": {"delivery": "a tested vertical slice"},
            "vibemin": {"checks": ["pytest -q"], "maxAttempts": 12},
        }
    }
    assert routing_for(policy, "/tmp/example/web", "implement") == ["claude", "codex"]
    assert model_for(policy, "/tmp/example", "codex") == {
        "model": "project-sol",
        "effort": "max",
    }
    assert "frontend" not in application_stack_for(policy, "/tmp/example")
    assert application_stack_for(policy, "/tmp/example")["delivery"] == "a tested vertical slice"
    assert "setup, usage" in application_stack_for(policy, "/tmp/example")["presentation"]
    assert vibemin_for(policy, "/tmp/example")["checks"] == ["pytest -q"]


def test_branch_convention_collapses_absent_ticket() -> None:
    config = {"branchPattern": "{kind}/{ticket}-{slug}"}
    assert render_branch(config, kind="feature", ticket="42", slug="demo") == "feature/42-demo"
    assert render_branch(config, kind="feature", slug="demo") == "feature/demo"
    assert slugify("A Nice App!") == "a-nice-app"


def test_vibemin_is_a_hard_completion_gate() -> None:
    policy = copy.deepcopy(DEFAULT_POLICY)
    ledger = Ledger(
        LedgerMeta("demo", "Demo", "in_progress", "/tmp/demo", "now", "now"),
        "# Demo",
        Path("/tmp/demo.md"),
    )
    result = run_completion_gate(policy, ledger)
    assert not result.ok
    assert "no worktrees" in result.reason


def test_project_prompt_includes_neutral_application_guidance(tmp_path: Path, monkeypatch) -> None:
    from fleet import paths

    monkeypatch.setattr(paths, "FLEET_HOME", tmp_path)
    ledger = Ledger(
        LedgerMeta("demo", "Demo", "in_progress", "/tmp/demo", "now", "now"),
        "# Demo",
        Path("/tmp/demo.md"),
    )
    prompt = compose_prompt(
        ledger,
        "build it",
        "implement",
        application_stack_for(DEFAULT_POLICY, "/tmp/demo"),
    )
    assert "README with setup, usage, and known limits" in prompt
    assert "Next.js" not in prompt
    assert "Supabase" not in prompt
    assert "custom hero" not in prompt


def test_vibemin_arguments_include_feature_base_and_guards() -> None:
    worktree = WorktreeRef("/tmp/repo", "/tmp/worktree", "feature/demo", "main")
    args = build_vibemin_args(
        {
            "checks": ["pytest -q"],
            "securityChecks": ["pytest -q tests/security"],
            "maxAttempts": 17,
            "timeout": 60,
        },
        worktree,
    )
    assert args[1:4] == ["-m", "vibemin", "--feature-base"]
    assert args[4] == "main"
    assert ["--check", "pytest -q"] == args[5:7]
    assert "--security-check" in args


def test_ledgers_round_trip_through_shared_markdown_format(tmp_path: Path, monkeypatch) -> None:
    from fleet import paths

    monkeypatch.setattr(paths, "LEDGER_DIR", tmp_path / "ledger")
    paths.LEDGER_DIR.mkdir()
    ledger = create_ledger("demo", "Demo task", "/tmp/repo")
    update_section("demo", "Current state", "The Python port works.")
    loaded = read_ledger("demo")
    assert loaded is not None
    assert loaded.meta.title == "Demo task"
    assert "The Python port works." in loaded.body
    assert ledger.path.suffix == ".md"


def test_setup_dry_run_does_not_write(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr("fleet.setup.Path.home", lambda: tmp_path)
    result = setup_host("codex", dry_run=True)
    assert result["ok"]
    assert result["skill"].endswith(".agents/skills/fleet/SKILL.md")
    assert not (tmp_path / ".codex").exists()


def test_statusline_setup_preserves_existing_preferences() -> None:
    codex = merge_codex_statusline(
        '[tui]\nstatus_line = ["current-dir"]\n'
        "status_line_use_colors = false\nnotifications = true\n"
    )
    assert '"current-dir"' in codex
    assert '"task-progress"' in codex
    assert "status_line_use_colors = false" in codex
    assert "notifications = true" in codex

    chosen = {"statusLine": {"type": "command", "command": "my-bar"}}
    assert merge_claude_statusline(chosen) == (chosen, False)


def test_statusline_renders_project_model_and_idle_state(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("fleet.statusline.paths.STATE_DIR", tmp_path / "state")
    (tmp_path / "state").mkdir()
    rendered = render_statusline(
        {"cwd": str(tmp_path / "demo"), "model": {"display_name": "Codex Sol"}}
    )
    assert "demo" in rendered
    assert "Codex Sol" in rendered
    assert "fleet idle" in rendered


def test_python_cli_exposes_public_commands(capsys) -> None:
    with pytest.raises(SystemExit) as raised:
        main(["--version"])
    assert raised.value.code == 0
    assert "fleet 0.2.0" in capsys.readouterr().out


def test_python_mcp_exposes_the_shared_tool_contract() -> None:
    assert tuple(mcp._tool_manager._tools) == MCP_TOOL_NAMES


def test_requested_models_and_antigravity_are_available_to_routing_and_mcp() -> None:
    assert set(BACKEND_IDS) == set(BACKENDS)
    assert DEFAULT_POLICY["models"]["claude"] == {"model": "claude-opus-5", "effort": "high"}
    assert DEFAULT_POLICY["models"]["antigravity"] == {
        "model": "gemini-3.8-flash-high",
        "effort": "high",
    }
    assert DEFAULT_POLICY["models"]["copilot"]["model"] == "gpt-5.3-codex"
    assert DEFAULT_POLICY["models"]["pi"] == {
        "effort": "high",
    }
    for role, chain in DEFAULT_POLICY["routing"].items():
        first = ["claude", "codex"] if role == "review" else ["codex", "claude"]
        assert chain == [*first, "copilot", "antigravity", "mimo", "pi"]
    for name in ("fleet_delegate", "fleet_clear_cooldown"):
        properties = mcp._tool_manager._tools[name].parameters["properties"]
        for backend in BACKEND_IDS:
            assert f'"{backend}"' in json.dumps(properties["backend"])


def test_antigravity_args_handle_dash_leading_prompts_and_plan_mode() -> None:
    backend = BACKENDS["antigravity"]
    args = backend.args(
        {
            "prompt": "--review this",
            "cwd": "/tmp/worktree",
            "read_only": True,
            "model": "gemini-3.8-flash-high",
            "effort": "high",
            "extra_dirs": ["/tmp/ledger"],
        }
    )
    assert backend.binary == "agy"
    assert backend.streams_text_deltas
    assert args[0] == "--print=--review this"
    assert args[args.index("--mode") + 1] == "plan"
    assert "--dangerously-skip-permissions" not in args
    assert "--add-dir" not in args


def test_copilot_uses_the_supported_reasoning_effort_flag() -> None:
    args = BACKENDS["copilot"].args({"prompt": "review", "cwd": "/tmp", "effort": "high"})
    assert args[-2:] == ["--reasoning-effort", "high"]
    assert "--effort" not in args


def _agy_event(event: str, **body) -> str:
    return json.dumps({"event": event, event: body})


def test_antigravity_tagged_stream_parses_init_text_and_nonterminal_success() -> None:
    parse = BACKENDS["antigravity"].parser
    start = parse(_agy_event("init", model="gemini-3.8-flash-high", permission_mode="auto"))
    assert start["type"] == "run.start"
    assert start["data"]["model"] == "gemini-3.8-flash-high"
    assert parse(_agy_event("step_update", step_type="agent_response", text_delta="Hello ")) == {
        "type": "agent.text",
        "msg": "Hello ",
    }
    assert parse(_agy_event("step_update", step_type="agent_response", usage={})) is None
    result = parse(_agy_event("result", status="SUCCESS", usage={"total_tokens": 12}, num_turns=1))
    assert result["type"] == "agent.reasoning"
    assert "12 tokens" in result["msg"]
    assert parse(_agy_event("result", status="ERROR"))["type"] == "run.error"
    assert parse("malformed stream") is None
    assert parse('{"event":"step_update","step_update":[]}') is None


def test_antigravity_failed_tools_are_recoverable_and_outputs_are_bounded() -> None:
    parse = BACKENDS["antigravity"].parser
    active = parse(
        _agy_event(
            "step_update",
            step_type="tool",
            state="ACTIVE",
            tool_name="run_command",
            tool_info={"parameters": {"CommandLine": "git status --short"}},
        )
    )
    assert active["type"] == "tool.use"
    assert active["msg"] == "run_command git status --short"
    failed = parse(
        _agy_event(
            "step_update",
            step_type="tool",
            state="ERROR",
            tool_info={
                "name": "run_command",
                "error": {"message": "denied\nextra detail"},
                "output": "x" * 2500,
            },
        )
    )
    assert failed["type"] == "tool.result"
    assert failed["msg"] == "tool failed: denied"
    assert len(failed["data"]["output"]) == 2000


def test_antigravity_detects_failed_results_and_no_output_despite_zero_exit() -> None:
    backend = BACKENDS["antigravity"]
    assert backend.failure(_agy_event("result", status="ERROR"), 0) == "agy result status ERROR"
    assert backend.failure(_agy_event("result"), 0) == "agy result status unknown"
    assert backend.failure(_agy_event("result", status="SUCCESS"), 0) is None
    assert "every tool call was denied" in backend.failure("No output produced\n", 0)


@pytest.mark.parametrize("exit_code", [0, 1])
def test_antigravity_does_not_treat_agent_or_tool_content_as_diagnostics(exit_code: int) -> None:
    backend = BACKENDS["antigravity"]
    quoted = "RESOURCE_EXHAUSTED quota 429 UNAUTHENTICATED No output produced"
    stream = "\n".join(
        [
            _agy_event("step_update", step_type="agent_response", text_delta=quoted),
            _agy_event(
                "step_update", step_type="tool", state="COMPLETED", tool_info={"output": quoted}
            ),
            _agy_event("result", status="SUCCESS", response=quoted),
        ]
    )
    assert backend.exhaustion(stream, exit_code) is None
    assert backend.failure(stream, exit_code) is None


@pytest.mark.parametrize(
    "diagnostic,retry_after",
    [
        ("RESOURCE_EXHAUSTED retry in 7 minutes", 7 * 60_000),
        ("daily usage limit; Retry-After: 42", 42_000),
        ("out of credits", 6 * 3_600_000),
    ],
)
def test_antigravity_quota_diagnostics_trigger_failover_at_zero_exit(
    diagnostic: str, retry_after: int
) -> None:
    exhausted = BACKENDS["antigravity"].exhaustion(
        _agy_event("result", status="ERROR", error={"message": diagnostic}), 0
    )
    assert exhausted is not None
    assert exhausted.kind == "quota"
    assert exhausted.retry_after_ms == retry_after


def test_antigravity_preserves_stderr_diagnostics_and_ignores_truncated_json() -> None:
    backend = BACKENDS["antigravity"]
    auth = backend.exhaustion("UNAUTHENTICATED: please sign in\n", 0)
    assert auth.kind == "auth"
    assert auth.retry_after_ms == 12 * 3_600_000
    truncated = 'text_delta":"RESOURCE_EXHAUSTED No output produced"}}\n'
    stream = truncated + _agy_event("result", status="SUCCESS")
    assert backend.exhaustion(stream, 1) is None
    assert backend.failure(stream, 0) is None


@pytest.mark.parametrize("status", ["SUCCESS", "ERROR"])
def test_antigravity_runner_buffers_deltas_and_honors_zero_exit_failure(
    status: str, monkeypatch, tmp_path: Path
) -> None:
    from fleet.run import run_one

    stream = "\n".join(
        [
            _agy_event("step_update", step_type="agent_response", text_delta="Hello "),
            _agy_event("step_update", step_type="agent_response", text_delta="world"),
            _agy_event("result", status=status, usage={"total_tokens": 12}),
        ]
    )
    process = SimpleNamespace(stdout=io.StringIO(stream), stderr=io.StringIO(""), wait=lambda: 0)
    emitted = []
    monkeypatch.setattr(BACKENDS["antigravity"], "resolve", lambda: "/fake/agy")
    monkeypatch.setattr("fleet.run.subprocess.Popen", lambda *args, **kwargs: process)
    monkeypatch.setattr("fleet.run.emit", lambda event, *args: emitted.append(event))
    monkeypatch.setattr("fleet.run.paths.run_log_path", lambda *args: tmp_path / "run.jsonl")
    result = run_one(
        "antigravity",
        {"task_id": "demo", "run_id": "test", "cwd": str(tmp_path), "prompt": "say hello"},
    )
    assert result.final_message == "Hello world"
    if status == "SUCCESS":
        assert result.failure_reason is None
        assert len([event for event in emitted if event["type"] == "run.end"]) == 1
    else:
        assert result.failure_reason == "agy result status ERROR"
        assert not any(event["type"] == "run.end" for event in emitted)
        assert emitted[-1]["type"] == "run.error"


def test_pi_stream_contract_and_review_tools() -> None:
    backend = BACKENDS["pi"]
    samples = json.loads((Path(__file__).parent / "fixtures" / "pi-contract.json").read_text())
    for sample in samples:
        lines = [json.dumps(event, ensure_ascii=False) for event in sample["events"]]
        stream = "\n".join([*lines, sample.get("stderr", "")])
        assert backend.failure(stream, sample["exitCode"]) == sample["failure"], sample["name"]
        exhaustion = backend.exhaustion(stream, sample["exitCode"])
        assert (exhaustion.kind if exhaustion else None) == sample["kind"], sample["name"]
        if "retryAfterMs" in sample:
            assert exhaustion.retry_after_ms == sample["retryAfterMs"]
        parsed = [event for line in lines if (event := backend.parser(line))]
        if "types" in sample:
            assert [event["type"] for event in parsed] == sample["types"]
        if "text" in sample:
            message = next(event for event in parsed if event["type"] == "agent.text")
            assert message["msg"] == sample["text"]
            assert message["data"]["usage"]["totalTokens"] == 19
    options = {"task_id": "contract", "run_id": "contract", "cwd": "/tmp", "prompt": "--review"}
    args = backend.args(
        {
            **options,
            "read_only": True,
            "effort": "ultra",
            "model": "provider/id:low",
        }
    )
    assert args[args.index("--tools") + 1] == "read,grep,find,ls"
    assert "--no-extensions" in args and "--no-mcp" in args
    assert args[args.index("--thinking") + 1] == "max"
    assert args[args.index("--model") + 1] == "provider/id:low"
    assert args[-2:] == ["--", "--review"]
    with pytest.raises(ValueError, match="Unsupported Pi effort"):
        backend.args({**options, "effort": "invalid"})


def test_mimo_rejects_missing_credentials_and_clears_inherited_claude_tokens(monkeypatch) -> None:
    import pytest

    environment = BACKENDS["mimo"].env
    assert environment is not None
    monkeypatch.delenv("MIMO_API_KEY", raising=False)
    with pytest.raises(ValueError, match="MiMo requires MIMO_API_KEY"):
        environment({})
    monkeypatch.setenv("MIMO_API_KEY", "  ")
    with pytest.raises(ValueError, match="MiMo requires MIMO_API_KEY"):
        environment({})
    monkeypatch.setenv("MIMO_API_KEY", "test-only-key")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "test-only-oauth")
    result = environment({})
    assert result["ANTHROPIC_AUTH_TOKEN"] == "test-only-key"
    assert result["ANTHROPIC_API_KEY"] == ""
    assert result["CLAUDE_CODE_OAUTH_TOKEN"] == ""
