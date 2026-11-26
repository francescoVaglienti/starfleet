from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

GENERIC_PATTERNS = {
    "absolute home path": (
        r"(?i)/(?:Users|home)/[\w.-]+|/root(?:/|\b(?![\w(]))"
        r"|[A-Za-z]:[\\/]+Users[\\/]+[\w.-]+"
    ),
    "email address": (
        r"[\w.%+-]+@(?!(?:[\w.-]+\.)?(?:example\.(?:com|org|net)|invalid)(?![\w.-]))"
        r"[\w.-]+\.[A-Za-z]{2,}"
    ),
    "provider token": (
        r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}"
        r"|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}"
        r"|npm_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|sbp_[a-f0-9]{40}"
        r"|sb_secret_[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{35})\b"
    ),
    "private key": r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
    "credential assignment": (
        r"(?i)(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)"
        r"\s*[=:]\s*[\"'][A-Za-z0-9_+/=-]{24,}[\"']"
    ),
}


def command(root: Path, *args: str) -> str:
    return subprocess.check_output(args, cwd=root, text=True).strip()


def tracked_files(root: Path) -> list[str]:
    return [name for name in command(root, "git", "ls-files", "-z").split("\0") if name]


def local_denylist(root: Path) -> Path | None:
    configured = os.environ.get("FLEET_PRIVATE_DENYLIST")
    if configured:
        path = Path(configured).expanduser().resolve(strict=True)
        if not path.is_file():
            raise ValueError("FLEET_PRIVATE_DENYLIST must name a file")
        return path
    common = Path(command(root, "git", "rev-parse", "--git-common-dir"))
    main = (root / common).resolve().parent
    return next(
        (p for p in (root / ".private-denylist", main / ".private-denylist") if p.is_file()), None
    )


def patterns_for(root: Path) -> list[tuple[str, re.Pattern[str]]]:
    patterns = [(label, re.compile(pattern)) for label, pattern in GENERIC_PATTERNS.items()]
    private = local_denylist(root)
    count = 0
    if private:
        for number, line in enumerate(private.read_text().splitlines(), 1):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            try:
                patterns.append((f"local pattern {number}", re.compile(line, re.IGNORECASE)))
            except re.error:
                raise ValueError(f"Invalid local pattern on line {number}") from None
            count += 1
    print(f"Public gate: {count} local patterns loaded", flush=True)
    return patterns


def check_name(name: str) -> None:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name:
        raise ValueError(f"Unsafe path: {name}")
    for part in path.parts:
        if part in {
            ".git",
            ".fleet",
            ".private-denylist",
            "node_modules",
            "__pycache__",
            ".venv",
        } or part.startswith(".env"):
            raise ValueError(f"Private or generated file: {name}")


def scan(name: str, content: bytes, patterns: list[tuple[str, re.Pattern[str]]]) -> None:
    check_name(name)
    text = name + "\n" + content.decode("utf-8", errors="replace")
    if content.startswith((b"\xff\xfe", b"\xfe\xff")):
        text += "\n" + content.decode("utf-16", errors="replace")
    for label, pattern in patterns:
        match = pattern.search(text)
        if match:
            line = text.count("\n", 0, match.start())
            raise ValueError(f"{name}:{line}: {label} (value withheld)")


def scan_tree(root: Path, patterns: list[tuple[str, re.Pattern[str]]]) -> list[str]:
    names = tracked_files(root)
    if not names:
        raise ValueError("No tracked files to scan")
    if command(root, "git", "ls-files", "--unmerged"):
        raise ValueError("Resolve merge conflicts before release")
    for name in names:
        path = root / name
        if path.is_symlink() or any(
            parent.is_symlink() for parent in path.parents if parent != root
        ):
            raise ValueError(f"Symlink not supported in public tree: {name}")
        if not path.is_file():
            raise ValueError(f"Missing or non-file tracked entry: {name}")
        scan(name, path.read_bytes(), patterns)
    print(f"PASS tree: {len(names)} tracked files", flush=True)
    return names


def archive_members(path: Path):
    if path.suffix == ".whl":
        with zipfile.ZipFile(path) as archive:
            for entry in archive.infolist():
                if entry.is_dir():
                    continue
                if (entry.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError(f"Symlink in wheel: {entry.filename}")
                yield entry.filename, archive.read(entry)
    else:
        with tarfile.open(path, "r:gz") as archive:
            for entry in archive:
                if entry.isdir():
                    continue
                if not entry.isfile():
                    raise ValueError(f"Non-file archive member: {entry.name}")
                stream = archive.extractfile(entry)
                if stream is None:
                    raise ValueError(f"Unreadable archive member: {entry.name}")
                yield entry.name, stream.read()


def scan_artifact(
    path: Path, names: list[str], patterns: list[tuple[str, re.Pattern[str]]]
) -> None:
    public_docs = {"README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md"}
    npm = public_docs | {"package.json", "bin/fleet", "assets/fleet-hero.svg", "skill/SKILL.md"}
    extension_sources = {
        n
        for n in names
        if n == "pi-extension/index.ts" or n.startswith("pi-extension/lib/") and n.endswith(".ts")
    }
    npm.update(extension_sources)
    npm.add("pi-extension/README.md")
    pi_package = {str(PurePosixPath(n).relative_to("pi-extension")) for n in extension_sources}
    pi_package.update({"package.json", "README.md", "LICENSE", "skills/fleet/SKILL.md"})
    npm.update(
        "dist/" + str(PurePosixPath(n).relative_to("src").with_suffix(".js"))
        for n in names
        if n.startswith("src/") and n.endswith(".ts") and not n.endswith(".d.ts")
    )
    python = {n for n in names if n.startswith("fleet/") and n.endswith((".py", ".md"))}
    seen: set[str] = set()
    kind = (
        "wheel"
        if path.suffix == ".whl"
        else "pi-fleet"
        if path.name.startswith("pi-fleet-") and path.suffix == ".tgz"
        else "npm"
        if path.suffix == ".tgz"
        else "sdist"
    )
    roots: set[str] = set()
    for name, content in archive_members(path):
        scan(name, content, patterns)
        parts = PurePosixPath(name).parts
        roots.add(parts[0])
        relative = "/".join(parts[1:]) if kind != "wheel" else name
        if relative in seen:
            raise ValueError(f"Duplicate archive member: {name}")
        seen.add(relative)
        if kind in {"npm", "pi-fleet"}:
            allowed = parts[0] == "package" and relative in (npm if kind == "npm" else pi_package)
        elif kind == "sdist":
            allowed = relative in set(names) | {"PKG-INFO"}
        else:
            metadata = parts[0].endswith(".dist-info") and "/".join(parts[1:]) in {
                "METADATA",
                "WHEEL",
                "RECORD",
                "entry_points.txt",
                "licenses/LICENSE",
            }
            allowed = name in python or metadata
        if not allowed:
            raise ValueError(f"Unexpected {kind} member: {name}")
    required = (
        npm
        if kind == "npm"
        else pi_package
        if kind == "pi-fleet"
        else python
        if kind == "wheel"
        else python | {"pyproject.toml", "PKG-INFO"}
    )
    if not required <= seen or (kind != "wheel" and len(roots) != 1):
        raise ValueError(f"Incomplete or malformed {kind}: {path.name}")
    print(f"PASS {kind}: {len(seen)} files ({path.name})", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tree-only", action="store_true")
    parser.add_argument("--artifact", action="append", type=Path, default=[])
    args = parser.parse_args()
    root = Path(command(Path.cwd(), "git", "rev-parse", "--show-toplevel"))
    patterns = patterns_for(root)
    names = scan_tree(root, patterns)
    if args.tree_only:
        if args.artifact:
            raise ValueError("--tree-only cannot be combined with --artifact")
        return
    if args.artifact:
        for artifact in args.artifact:
            scan_artifact(artifact, names, patterns)
        return
    subprocess.run(["pnpm", "build"], cwd=root, check=True)
    subprocess.run(["pnpm", "build"], cwd=root / "pi-extension", check=True)
    with tempfile.TemporaryDirectory(prefix="fleet-public-pack-") as directory:
        subprocess.run(
            ["npm", "pack", "--ignore-scripts", "--dry-run=false", "--pack-destination", directory],
            cwd=root,
            check=True,
        )
        subprocess.run(["uv", "build", "--out-dir", directory], cwd=root, check=True)
        subprocess.run(
            ["npm", "pack", "--ignore-scripts", "--dry-run=false", "--pack-destination", directory],
            cwd=root / "pi-extension",
            check=True,
        )
        artifacts = [
            p for p in Path(directory).iterdir() if p.name.endswith((".tgz", ".whl", ".tar.gz"))
        ]
        if len(artifacts) != 4:
            raise ValueError(
                "Expected fleet-ai and pi-fleet npm tarballs, one wheel, and one sdist"
            )
        for artifact in sorted(artifacts):
            scan_artifact(artifact, names, patterns)
    print("PASS public release gate", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (
        OSError,
        ValueError,
        subprocess.CalledProcessError,
        tarfile.TarError,
        zipfile.BadZipFile,
    ) as error:
        print(f"FAIL public release gate: {error}", file=sys.stderr)
        sys.exit(1)
