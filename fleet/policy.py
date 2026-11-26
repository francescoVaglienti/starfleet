"""Fleet policy loading, routing/model resolution, and vendor permission compilers."""

from __future__ import annotations

import copy
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

from fleet import paths

BEGIN = "# >>> fleet managed — do not edit between markers >>>"
END = "# <<< fleet managed <<<"

DEFAULT_POLICY: dict[str, Any] = {
    "defaults": {
        "commands": [
            "ls",
            "cat",
            "head",
            "tail",
            "grep",
            "rg",
            "find",
            "fd",
            "wc",
            "sed",
            "awk",
            "echo",
            "pwd",
            "which",
            "file",
            "stat",
            "diff",
            "sort",
            "uniq",
            "tree",
            "mkdir",
            "touch",
            "cp",
            "mv",
            "git",
            "gh",
            "node",
            "npm",
            "npx",
            "pnpm",
            "yarn",
            "bun",
            "tsc",
            "tsx",
            "vitest",
            "jest",
            "python3",
            "pip3",
            "uv",
            "ruff",
            "black",
            "pytest",
            "poetry",
            "mypy",
            "cargo",
            "go",
            "make",
            "just",
            "docker",
            "supabase",
            "vercel",
            "curl",
            "jq",
            "vibemin",
        ],
        "denyCommands": [
            "rm -rf /",
            "sudo",
            "shutdown",
            "reboot",
            "diskutil",
            "mkfs",
            "git push --force",
            "git reset --hard origin",
        ],
        "write": True,
        "network": True,
        "applicationStack": {
            "delivery": "a working application with end-to-end checks",
            "presentation": "a README with setup, usage, and known limits",
        },
    },
    "routing": {
        "manage": ["codex", "claude", "copilot", "antigravity", "mimo", "pi"],
        "implement": ["codex", "claude", "copilot", "antigravity", "mimo", "pi"],
        "review": ["claude", "codex", "copilot", "antigravity", "mimo", "pi"],
        "chore": ["codex", "claude", "copilot", "antigravity", "mimo", "pi"],
    },
    "cooldown": {"defaultMinutes": 30, "failureMinutes": 10},
    "models": {
        "codex": {"model": "gpt-5.6-sol", "effort": "high"},
        "claude": {"model": "claude-opus-5", "effort": "high"},
        "copilot": {"model": "gpt-5.3-codex", "effort": "high"},
        "antigravity": {"model": "gemini-3.8-flash-high", "effort": "high"},
        "mimo": {"model": "mimo-v2.6-pro", "effort": "high"},
        "pi": {"effort": "high"},
    },
    "projects": {},
    "notify": {
        "on": ["exhausted", "failover", "permission.request", "run.error", "run.end"],
    },
    "cleanup": {
        "onDone": True,
        "keepBranch": True,
        "keepLedger": True,
        "salvage": [".env*", "*.pem", "*.key", "credentials*"],
        "salvageExclude": [
            ".venv",
            "venv",
            "node_modules",
            "site-packages",
            "__pycache__",
            "dist",
            "build",
            ".next",
            ".git",
        ],
    },
    # Completion is impossible until every worktree has passed Vibemin.
    "vibemin": {"required": True, "maxAttempts": 500, "timeout": 300},
}


def _merged(default: dict[str, Any], override: Any) -> dict[str, Any]:
    value = copy.deepcopy(default)
    if isinstance(override, dict):
        value.update(override)
    return value


def load_policy() -> dict[str, Any]:
    paths.ensure_dirs()
    if not paths.POLICY.exists():
        save_policy(DEFAULT_POLICY)
        return copy.deepcopy(DEFAULT_POLICY)
    try:
        raw = yaml.safe_load(paths.POLICY.read_text()) or {}
    except (OSError, yaml.YAMLError) as error:
        raise RuntimeError(f"Could not parse {paths.POLICY}: {error}") from error
    if not isinstance(raw, dict):
        raise RuntimeError(f"Could not parse {paths.POLICY}: top level must be a mapping")
    return {
        "defaults": _merged(DEFAULT_POLICY["defaults"], raw.get("defaults")),
        "routing": _merged(DEFAULT_POLICY["routing"], raw.get("routing")),
        "cooldown": _merged(DEFAULT_POLICY["cooldown"], raw.get("cooldown")),
        "models": _merged(DEFAULT_POLICY["models"], raw.get("models")),
        "projects": raw.get("projects") if isinstance(raw.get("projects"), dict) else {},
        "notify": _merged(DEFAULT_POLICY["notify"], raw.get("notify")),
        "cleanup": _merged(DEFAULT_POLICY["cleanup"], raw.get("cleanup")),
        "vibemin": _merged(DEFAULT_POLICY["vibemin"], raw.get("vibemin")),
    }


def render_policy(policy: dict[str, Any]) -> str:
    return yaml.safe_dump(policy, sort_keys=False, allow_unicode=True)


def save_policy(policy: dict[str, Any]) -> None:
    paths.ensure_dirs()
    paths.POLICY.write_text(render_policy(policy))


def _expanded(value: str) -> str:
    return str(Path(value).expanduser().resolve())


def project_for(policy: dict[str, Any], cwd: str) -> dict[str, Any]:
    target = _expanded(cwd)
    best: dict[str, Any] = {}
    best_length = -1
    for configured, config in policy.get("projects", {}).items():
        if not isinstance(configured, str) or not isinstance(config, dict):
            continue
        root = _expanded(configured)
        if (target == root or target.startswith(root + "/")) and len(root) > best_length:
            best, best_length = config, len(root)
    return best


def routing_for(policy: dict[str, Any], project: str, role: str) -> list[str]:
    config = project_for(policy, project)
    project_routing = config.get("routing", {}) if isinstance(config.get("routing"), dict) else {}
    chain = project_routing.get(role, policy.get("routing", {}).get(role, []))
    return list(chain) if isinstance(chain, list) else []


def model_for(policy: dict[str, Any], project: str, backend: str) -> dict[str, str]:
    global_models = policy.get("models", {})
    base = global_models.get(backend, {}) if isinstance(global_models, dict) else {}
    config = project_for(policy, project)
    project_models = config.get("models", {}) if isinstance(config.get("models"), dict) else {}
    override = project_models.get(backend, {}) if isinstance(project_models, dict) else {}
    return {
        key: value
        for key, value in {**(base or {}), **(override or {})}.items()
        if key in {"model", "effort"} and isinstance(value, str)
    }


def vibemin_for(policy: dict[str, Any], project: str) -> dict[str, Any]:
    base = policy.get("vibemin", {})
    config = project_for(policy, project)
    return _merged(base if isinstance(base, dict) else {}, config.get("vibemin"))


def commands_for(policy: dict[str, Any], cwd: str) -> list[str]:
    config = project_for(policy, cwd)
    commands = set(policy.get("defaults", {}).get("commands", []))
    commands.update(config.get("commands", []))
    commands.difference_update(config.get("denyCommands", []))
    return sorted(commands)


def application_stack_for(policy: dict[str, Any], project: str) -> dict[str, str]:
    base = policy.get("defaults", {}).get("applicationStack", {})
    config = project_for(policy, project)
    override = config.get("applicationStack", {})
    if override is False:
        return {}
    values = {**(base if isinstance(base, dict) else {}), **(override or {})}
    return {key: str(value) for key, value in values.items() if value}


def _backup(path: Path) -> None:
    if not path.exists():
        return
    paths.BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).isoformat().replace(":", "-")
    shutil.copy2(path, paths.BACKUP_DIR / f"{path.name}.{stamp}.bak")


def _load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def _managed() -> dict[str, Any]:
    return _load_json(paths.MANAGED)


def sync_claude(policy: dict[str, Any], dry_run: bool) -> dict[str, Any]:
    config = _load_json(paths.CLAUDE_SETTINGS)
    permissions = config.get("permissions", {})
    permissions = permissions if isinstance(permissions, dict) else {}
    managed = _managed()
    owned = set(managed.get("claude", []))
    allow = [item for item in permissions.get("allow", []) if item not in owned]
    deny = [item for item in permissions.get("deny", []) if item not in owned]
    wanted_allow = [f"Bash({command}:*)" for command in policy["defaults"]["commands"]]
    wanted_deny = [f"Bash({command}:*)" for command in policy["defaults"]["denyCommands"]]
    next_config = {
        **config,
        "permissions": {
            **permissions,
            "allow": sorted(set(allow + wanted_allow)),
            "deny": sorted(set(deny + wanted_deny)),
        },
    }
    changed = next_config != config
    if changed and not dry_run:
        _backup(paths.CLAUDE_SETTINGS)
        _save_json(paths.CLAUDE_SETTINGS, next_config)
        managed["claude"] = wanted_allow + wanted_deny
        _save_json(paths.MANAGED, managed)
    return {"target": "claude", "path": str(paths.CLAUDE_SETTINGS), "changed": changed}


def _strip_managed_codex(toml: str, projects: set[str]) -> str:
    toml = re.sub(re.escape(BEGIN) + r"[\s\S]*?" + re.escape(END) + r"\n?", "", toml)
    output: list[str] = []
    dropping = False
    for line in toml.splitlines():
        header = re.match(r"^\s*\[\[?([^\]]+)\]\]?\s*$", line)
        if header:
            name = header.group(1).strip()
            if name == "sandbox_workspace_write":
                dropping = True
            elif name.startswith("projects."):
                project = name[len("projects.") :].strip('"')
                dropping = project in projects
            else:
                dropping = False
        if not dropping:
            output.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(output)).strip()


def sync_codex(policy: dict[str, Any], dry_run: bool) -> list[dict[str, Any]]:
    deny = policy["defaults"]["denyCommands"]
    allow = policy["defaults"]["commands"]
    rule_lines = [
        "# Generated by `fleet policy sync`. Source: ~/.fleet/policy.yaml",
        "",
        *[
            f'prefix_rule(pattern={json.dumps(command.split())}, decision="forbidden")'
            for command in deny
        ],
        *[f'prefix_rule(pattern=[{json.dumps(command)}], decision="allow")' for command in allow],
        "",
    ]
    rules = "\n".join(rule_lines)
    old_rules = paths.CODEX_RULES.read_text() if paths.CODEX_RULES.exists() else ""
    rules_changed = rules != old_rules
    if rules_changed and not dry_run:
        paths.CODEX_RULES.parent.mkdir(parents=True, exist_ok=True)
        paths.CODEX_RULES.write_text(rules)

    projects = policy.get("projects", {})
    trusted = [
        _expanded(project)
        for project, config in projects.items()
        if isinstance(config, dict) and config.get("trust") == "trusted"
    ]
    roots: list[str] = []
    for project, config in projects.items():
        if not isinstance(config, dict) or config.get("write") is False:
            continue
        roots.append(_expanded(project))
        roots.extend(_expanded(root) for root in config.get("writableRoots", []))
    roots = list(dict.fromkeys(roots))
    block = [BEGIN]
    if roots:
        block += [
            "[sandbox_workspace_write]",
            f"writable_roots = {json.dumps(roots)}",
            f"network_access = {str(bool(policy['defaults']['network'])).lower()}",
            "",
        ]
    for project in trusted:
        block += [f"[projects.{json.dumps(project)}]", 'trust_level = "trusted"', ""]
    block.append(END)

    current = paths.CODEX_CONFIG.read_text() if paths.CODEX_CONFIG.exists() else ""
    base = _strip_managed_codex(current, set(trusted) | set(roots))
    next_config = (base + "\n\n" if base else "") + "\n".join(block) + "\n"
    config_changed = next_config != current and bool(trusted or roots or BEGIN in current)
    if config_changed and not dry_run:
        _backup(paths.CODEX_CONFIG)
        paths.CODEX_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        paths.CODEX_CONFIG.write_text(next_config)
    return [
        {"target": "codex:rules", "path": str(paths.CODEX_RULES), "changed": rules_changed},
        {"target": "codex:config", "path": str(paths.CODEX_CONFIG), "changed": config_changed},
    ]


def sync_copilot(policy: dict[str, Any], dry_run: bool) -> dict[str, Any]:
    config = _load_json(paths.COPILOT_PERMISSIONS)
    locations = dict(config.get("locations", {}))
    managed = _managed()
    for old in managed.get("copilot", []):
        if old not in policy.get("projects", {}):
            locations.pop(old, None)
    owned: list[str] = []
    for project, project_config in policy.get("projects", {}).items():
        commands = commands_for(policy, project)
        approvals: list[dict[str, Any]] = [{"kind": "commands", "commandIdentifiers": commands}]
        if project_config.get("write") is not False:
            approvals.insert(0, {"kind": "write"})
        locations[_expanded(project)] = {"tool_approvals": approvals}
        owned.append(project)
    next_config = {**config, "locations": locations}
    changed = next_config != config
    if changed and not dry_run:
        _backup(paths.COPILOT_PERMISSIONS)
        _save_json(paths.COPILOT_PERMISSIONS, next_config)
        managed["copilot"] = owned
        _save_json(paths.MANAGED, managed)
    return {"target": "copilot", "path": str(paths.COPILOT_PERMISSIONS), "changed": changed}


def sync_all(policy: dict[str, Any], dry_run: bool = False) -> list[dict[str, Any]]:
    return [
        sync_claude(policy, dry_run),
        *sync_codex(policy, dry_run),
        sync_copilot(policy, dry_run),
    ]
