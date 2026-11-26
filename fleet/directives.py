"""User-owned standing instructions injected into every delegated run."""

from __future__ import annotations

import re

from fleet import paths


def directives_for(repo_path: str) -> str:
    parts: list[str] = []
    global_path = paths.FLEET_HOME / "DIRECTIVES.md"
    if global_path.exists():
        parts.append(global_path.read_text().strip())
    directory = paths.FLEET_HOME / "directives"
    if directory.exists():
        for path in sorted(directory.glob("*.md")):
            raw = path.read_text()
            match = re.search(r"^<!--\s*applies-to:\s*(.+?)\s*-->\s*", raw, re.MULTILINE)
            prefixes = re.split(r"[,\s]+", match.group(1)) if match else []
            if prefixes and not any(repo_path.startswith(prefix) for prefix in prefixes):
                continue
            body = re.sub(r"^<!--[\s\S]*?-->\s*", "", raw).strip()
            if body:
                parts.append(f"<!-- scoped: {path.stem} -->\n{body}")
    return "\n\n".join(part for part in parts if part)
