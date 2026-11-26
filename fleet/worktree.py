"""Git worktree creation, locking, inspection, and conservative cleanup."""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fleet import paths
from fleet.ledger import read_ledger, write_ledger
from fleet.models import WorktreeRef
from fleet.policy import project_for


def git(repo: str | Path, *args: str, check: bool = True) -> str:
    process = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=False
    )
    if check and process.returncode:
        raise RuntimeError(process.stderr.strip() or f"git {' '.join(args)} failed")
    return process.stdout.strip()


def git_quiet(repo: str | Path, *args: str) -> str | None:
    try:
        return git(repo, *args)
    except (OSError, RuntimeError):
        return None


def is_git_repo(directory: str | Path) -> bool:
    return git_quiet(directory, "rev-parse", "--is-inside-work-tree") == "true"


def repo_root(directory: str | Path) -> str | None:
    return git_quiet(directory, "rev-parse", "--show-toplevel")


def slugify(value: str) -> str:
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", value.lower()))[:48]


def detect_base_branch(repo: str, config: dict[str, Any]) -> str:
    if config.get("baseBranch"):
        return str(config["baseBranch"])
    head = git_quiet(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    if head:
        return re.sub(r"^origin/", "", head)
    for candidate in ("develop", "main", "master"):
        if git_quiet(repo, "rev-parse", "--verify", f"refs/remotes/origin/{candidate}") is not None:
            return candidate
    return git_quiet(repo, "rev-parse", "--abbrev-ref", "HEAD") or "main"


def render_branch(
    config: dict[str, Any], *, slug: str, kind: str | None = None, ticket: str | None = None
) -> str:
    pattern = str(config.get("branchPattern", "{kind}/{ticket}-{slug}"))
    branch = (
        pattern.replace("{kind}", kind or str(config.get("defaultKind", "task")))
        .replace("{ticket}", ticket or "")
        .replace("{slug}", slug)
    )
    return re.sub(r"/+$", "", re.sub(r"-+$", "", re.sub(r"-{2,}", "-", branch.replace("/-", "/"))))


def repos_for_project(project: str, config: dict[str, Any]) -> list[str]:
    repos = config.get("repos", [])
    if not repos:
        return [str(Path(project).expanduser().resolve())]
    root = Path(project).expanduser()
    return [
        str((Path(repo) if Path(repo).is_absolute() else root / repo).resolve()) for repo in repos
    ]


def worktree_path_for(config: dict[str, Any], repo: str, task_id: str, slug: str) -> str:
    template = str(config.get("worktreeRoot", paths.WORKTREE_DIR / "{repoName}-{taskId}"))
    return (
        template.replace("{repoName}", Path(repo).name)
        .replace("{taskId}", task_id)
        .replace("{slug}", slug)
    )


@dataclass
class WorktreeInfo:
    path: str
    branch: str
    head: str


def list_worktrees(repo: str) -> list[WorktreeInfo]:
    raw = git_quiet(repo, "worktree", "list", "--porcelain")
    if raw is None:
        return []
    output: list[WorktreeInfo] = []
    current: dict[str, str] = {}
    for line in [*raw.splitlines(), "worktree "]:
        if line.startswith("worktree "):
            if current.get("path"):
                output.append(
                    WorktreeInfo(
                        current["path"], current.get("branch", ""), current.get("head", "")
                    )
                )
            current = {"path": line[9:]}
        elif line.startswith("HEAD "):
            current["head"] = line[5:]
        elif line.startswith("branch "):
            current["branch"] = line[7:].removeprefix("refs/heads/")
    return output


def ensure_worktrees(
    policy: dict[str, Any],
    project: str,
    task_id: str,
    *,
    slug: str,
    kind: str | None = None,
    ticket: str | None = None,
    repos: list[str] | None = None,
    base: str | None = None,
) -> list[WorktreeRef]:
    config = project_for(policy, project)
    selected = repos or repos_for_project(project, config)
    output: list[WorktreeRef] = []
    for repo in selected:
        repo = str(Path(repo).expanduser().resolve())
        if not is_git_repo(repo):
            raise RuntimeError(f"Not a git repository: {repo}")
        root = repo_root(repo) or repo
        if config.get("requireTicket") and not ticket:
            raise RuntimeError(f"Project {project} requires a ticket number. Pass --ticket.")
        branch = render_branch(config, slug=slug, kind=kind, ticket=ticket)
        base_branch = base or detect_base_branch(root, config)
        if base and git_quiet(root, "rev-parse", "--verify", base) is None:
            raise RuntimeError(f"Base ref not found in {root}: {base}")
        worktree_path = worktree_path_for(config, root, task_id, slug)
        existing = next(
            (
                item
                for item in list_worktrees(root)
                if item.path == worktree_path or item.branch == branch
            ),
            None,
        )
        if existing:
            output.append(WorktreeRef(root, existing.path, existing.branch, base_branch))
            continue
        Path(worktree_path).parent.mkdir(parents=True, exist_ok=True)
        branch_exists = git_quiet(root, "rev-parse", "--verify", f"refs/heads/{branch}") is not None
        start = (
            f"origin/{base_branch}"
            if git_quiet(root, "rev-parse", "--verify", f"refs/remotes/origin/{base_branch}")
            is not None
            else base_branch
        )
        if branch_exists:
            git(root, "worktree", "add", worktree_path, branch)
        else:
            git(root, "worktree", "add", "-b", branch, worktree_path, start)
        output.append(WorktreeRef(root, worktree_path, branch, base_branch))
    return output


def dirty_files(worktree: str) -> list[str]:
    raw = git_quiet(worktree, "status", "--porcelain=v1", "--untracked-files=all")
    return raw.splitlines() if raw else []


def commits_ahead(repo: str, base: str) -> tuple[str, int] | None:
    branch = git_quiet(repo, "rev-parse", "--abbrev-ref", "HEAD")
    if not branch or branch in {"HEAD", base}:
        return None
    count = int(git_quiet(repo, "rev-list", "--count", f"{base}..{branch}") or 0)
    return (branch, count) if count else None


def _lock_path(worktree: str) -> Path:
    digest = hashlib.sha1(worktree.encode()).hexdigest()[:8]
    return paths.STATE_DIR / f"lock-{slugify(worktree)}-{digest}.json"


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def acquire_lock(worktree: str, value: dict[str, Any]) -> dict[str, Any] | None:
    lock_path = _lock_path(worktree)
    try:
        held = json.loads(lock_path.read_text())
        if _alive(int(held["pid"])):
            return held
    except (OSError, ValueError, KeyError, json.JSONDecodeError):
        pass
    paths.STATE_DIR.mkdir(parents=True, exist_ok=True)
    from fleet.events import now

    lock_path.write_text(json.dumps({**value, "since": now()}, indent=2) + "\n")
    return None


def release_lock(worktree: str) -> None:
    _lock_path(worktree).unlink(missing_ok=True)


def branch_preservation(ref: WorktreeRef, policy_base: str | None = None) -> str | None:
    local = git_quiet(ref.repo, "rev-parse", "--verify", f"refs/heads/{ref.branch}")
    remote = git_quiet(ref.repo, "rev-parse", "--verify", f"refs/remotes/origin/{ref.branch}")
    if not local:
        return "pushed" if remote else "missing"
    for base in (ref.base, policy_base):
        if base and git_quiet(ref.repo, "merge-base", "--is-ancestor", local, base) is not None:
            return "merged"
    if (
        remote
        and git_quiet(ref.repo, "merge-base", "--is-ancestor", local, f"origin/{ref.branch}")
        is not None
    ):
        return "pushed"
    return None


@dataclass
class SalvageFile:
    source: Path
    destination: Path
    relative_path: str


def plan_salvage(
    worktree: str, task_id: str, patterns: list[str], exclude: list[str], namespace: str = ""
) -> list[SalvageFile]:
    destination_root = paths.FLEET_HOME / "salvage" / slugify(task_id)
    if namespace:
        destination_root /= slugify(namespace)
    output: list[SalvageFile] = []
    for root, directories, filenames in os.walk(worktree):
        directories[:] = [item for item in directories if item not in exclude]
        for filename in filenames:
            if not any(fnmatch.fnmatch(filename, pattern) for pattern in patterns):
                continue
            source = Path(root) / filename
            relative = source.relative_to(worktree)
            output.append(SalvageFile(source, destination_root / relative, str(relative)))
    return output


def _perform_salvage(files: list[SalvageFile]) -> None:
    for item in files:
        item.destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if item.destination.exists():
            if item.source.read_bytes() != item.destination.read_bytes():
                raise RuntimeError(
                    f"salvage destination exists with different contents: {item.destination}"
                )
            continue
        shutil.copy2(item.source, item.destination)
        if item.source.read_bytes() != item.destination.read_bytes():
            raise RuntimeError(f"salvage verification failed: {item.destination}")


def cleanup_task_worktrees(
    policy: dict[str, Any], task_id: str, force: bool = False
) -> dict[str, Any]:
    ledger = read_ledger(task_id)
    if not ledger:
        return {"ok": False, "reason": "No such task"}
    if not ledger.meta.worktrees:
        return {"ok": False, "reason": "No worktrees recorded"}
    if not force and ledger.meta.status == "in_progress":
        return {"ok": False, "reason": "R2: task is in_progress; mark it done or pass --force"}
    active = [item for item in ledger.meta.worktrees if Path(item.path).exists()]
    for item in active:
        held = acquire_lock(
            item.path,
            {
                "backend": "fleet",
                "runId": f"cleanup-{task_id}",
                "taskId": task_id,
                "pid": os.getpid(),
            },
        )
        if held:
            return {"ok": False, "reason": f"R3: run {held.get('runId')} is live in {item.path}"}
        release_lock(item.path)
        if not force and dirty_files(item.path):
            return {"ok": False, "reason": f"R1: worktree is dirty: {item.path}"}
    namespaces = {item.path: ("" if len(active) == 1 else Path(item.path).name) for item in active}
    salvage: list[SalvageFile] = []
    for item in active:
        salvage.extend(
            plan_salvage(
                item.path,
                task_id,
                policy["cleanup"]["salvage"],
                policy["cleanup"].get("salvageExclude", []),
                namespaces[item.path],
            )
        )
    try:
        _perform_salvage(salvage)
    except (OSError, RuntimeError) as error:
        return {"ok": False, "reason": f"R5: salvage failed: {error}"}
    removed: list[WorktreeRef] = []
    try:
        for item in active:
            item.head = git_quiet(item.repo, "rev-parse", "--verify", f"refs/heads/{item.branch}")
            git(item.repo, "worktree", "remove", "--force", item.path)
            git(item.repo, "worktree", "prune")
            removed.append(item)
    except RuntimeError as error:
        return {
            "ok": False,
            "reason": f"R6: removal failed after {len(removed)} worktrees: {error}",
        }
    keys = {(item.repo, item.path, item.branch) for item in removed}
    ledger.meta.worktrees = [
        item for item in ledger.meta.worktrees if (item.repo, item.path, item.branch) not in keys
    ]
    ledger.meta.removed_worktrees.extend(removed)
    write_ledger(ledger)
    kept: list[str] = []
    for item in removed:
        if policy["cleanup"].get("keepBranch", True) or not branch_preservation(
            item, project_for(policy, item.repo).get("baseBranch")
        ):
            kept.append(item.branch)
        elif git_quiet(item.repo, "rev-parse", "--verify", f"refs/heads/{item.branch}"):
            git(item.repo, "branch", "-D", item.branch)
    return {
        "ok": True,
        "salvaged": [item.relative_path for item in salvage],
        "keptBranches": kept,
        "removedWorktrees": [item.path for item in removed],
    }
