from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

from check_public import command, local_denylist, patterns_for, scan_tree


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Export tracked working files with fresh history; never push."
    )
    parser.add_argument("target", type=Path)
    args = parser.parse_args()
    source = Path(command(Path.cwd(), "git", "rev-parse", "--show-toplevel"))
    target = args.target.expanduser().absolute()
    if target.exists() or target.is_symlink():
        raise ValueError("Target must not exist")
    if target.resolve().is_relative_to(source.resolve()):
        raise ValueError("Target must be outside the source repository")
    names = scan_tree(source, patterns_for(source))
    private = local_denylist(source)
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(
        {
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_AUTHOR_NAME": "Fleet Release",
            "GIT_AUTHOR_EMAIL": "release@example.invalid",
            "GIT_COMMITTER_NAME": "Fleet Release",
            "GIT_COMMITTER_EMAIL": "release@example.invalid",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
    )
    if private:
        env["FLEET_PRIVATE_DENYLIST"] = str(private)
    target.mkdir(parents=True)
    for name in names:
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / name, destination)

    def run(*args: str) -> None:
        subprocess.run(args, cwd=target, env=env, check=True)

    run("git", "init", "--quiet", "--initial-branch=main", "--template=")
    run("git", "add", "--force", "--", *names)
    run("pnpm", "install", "--frozen-lockfile", "--ignore-scripts")
    run("sh", "scripts/check-public.sh")
    run("git", "diff", "--exit-code")
    run(
        "git",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--quiet",
        "-m",
        "Initial public release",
    )
    for directory in ("node_modules", "dist", "pi-extension/skills"):
        shutil.rmtree(target / directory, ignore_errors=True)
    (target / "pi-extension/LICENSE").unlink(missing_ok=True)
    if command(target, "git", "rev-list", "--count", "HEAD") != "1":
        raise ValueError("Export must have exactly one commit")
    if command(target, "git", "remote") or command(target, "git", "status", "--porcelain"):
        raise ValueError("Export must be clean and have no remotes")
    print(f"PASS public export: {target}")
    print(f"One commit: {command(target, 'git', 'rev-parse', 'HEAD')}")
    print("No remotes. Nothing pushed.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"FAIL public export: {error}", file=sys.stderr)
        sys.exit(1)
