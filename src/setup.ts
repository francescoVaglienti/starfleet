import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME, P } from "./paths.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");

export const CODEX_STATUS_ITEMS = [
  "model-with-reasoning",
  "project-name",
  "git-branch",
  "run-state",
  "task-progress",
  "context-remaining",
  "five-hour-limit",
  "weekly-limit",
] as const;

export interface SetupResult {
  ok: boolean;
  host: "codex" | "claude";
  skill?: string;
  command?: string;
  message?: string;
  statusLine?: string;
  reason?: string;
}

function backup(path: string): void {
  if (!existsSync(path)) return;
  mkdirSync(P.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(path, join(P.backupDir, `${path.split("/").at(-1)}.${stamp}.bak`));
}

export function mergeCodexStatusline(config: string): string {
  const lines = config.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const start = lines.findIndex((line) => line.trim() === "[tui]");
  const recommended = JSON.stringify(CODEX_STATUS_ITEMS);
  if (start < 0) {
    const prefix = config.trimEnd();
    return `${prefix ? `${prefix}\n\n` : ""}[tui]\nstatus_line = ${recommended}\nstatus_line_use_colors = true\n`;
  }

  let end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  if (end < 0) end = lines.length;
  const statusStart = lines.findIndex(
    (line, index) => index > start && index < end && /^\s*status_line\s*=/.test(line),
  );
  if (statusStart < 0) {
    lines.splice(start + 1, 0, `status_line = ${recommended}`);
    end += 1;
  } else {
    let statusEnd = statusStart + 1;
    let assignment = lines[statusStart]!;
    while ((assignment.match(/\[/g)?.length ?? 0) > (assignment.match(/\]/g)?.length ?? 0) && statusEnd < end) {
      assignment += `\n${lines[statusEnd]}`;
      statusEnd += 1;
    }
    const existing: string[] = [];
    for (const match of assignment.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
      try {
        existing.push(JSON.parse(`"${match[1]}"`) as string);
      } catch {
        // Preserve every valid item and ignore only malformed string fragments.
      }
    }
    const merged = [...new Set([...existing, ...CODEX_STATUS_ITEMS])];
    lines.splice(statusStart, statusEnd - statusStart, `status_line = ${JSON.stringify(merged)}`);
    end += 1 - (statusEnd - statusStart);
  }
  if (!lines.some((line, index) => index > start && index < end && /^\s*status_line_use_colors\s*=/.test(line))) {
    lines.splice(start + 2, 0, "status_line_use_colors = true");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function mergeClaudeStatusline(config: Record<string, unknown>): {
  config: Record<string, unknown>;
  changed: boolean;
} {
  if (config.statusLine) return { config, changed: false };
  return {
    config: {
      ...config,
      statusLine: { type: "command", command: "fleet statusline", padding: 0 },
    },
    changed: true,
  };
}

function installCodexStatusline(dryRun: boolean): string {
  const target = join(HOME, ".codex", "config.toml");
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  const updated = mergeCodexStatusline(current);
  if (updated === current) return `Codex status bar already configured in ${target}`;
  if (!dryRun) {
    backup(target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, updated);
  }
  return `${dryRun ? "Would configure" : "Configured"} Codex status bar in ${target}`;
}

function installClaudeStatusline(dryRun: boolean): string {
  const target = join(HOME, ".claude", "settings.json");
  let current: Record<string, unknown> = {};
  if (existsSync(target)) {
    try {
      const parsed = JSON.parse(readFileSync(target, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return `Kept ${target}; its JSON root is not an object`;
      }
      current = parsed as Record<string, unknown>;
    } catch (error) {
      return `Kept invalid ${target}; fix its JSON before installing the Fleet status line (${(error as Error).message})`;
    }
  }
  const merged = mergeClaudeStatusline(current);
  if (!merged.changed) return `Kept existing Claude status line in ${target}`;
  if (!dryRun) {
    backup(target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(merged.config, null, 2)}\n`);
  }
  return `${dryRun ? "Would configure" : "Configured"} Fleet-aware Claude status line in ${target}`;
}

export function setupHost(host: "codex" | "claude", dryRun = false): SetupResult {
  const root = join(HOME, host === "codex" ? ".agents" : ".claude");
  const skill = join(root, "skills", "fleet", "SKILL.md");
  const source = join(PACKAGE_ROOT, "skill", "SKILL.md");
  const add = host === "codex"
    ? ["mcp", "add", "fleet", "--", "fleet", "mcp"]
    : ["mcp", "add", "fleet", "-s", "user", "--", "fleet", "mcp"];
  const statusLine = host === "codex"
    ? installCodexStatusline(dryRun)
    : installClaudeStatusline(dryRun);
  if (dryRun) {
    return { ok: true, host, skill, command: `${host} ${add.join(" ")}`, statusLine };
  }
  try {
    mkdirSync(dirname(skill), { recursive: true });
    copyFileSync(source, skill);
  } catch (error) {
    return { ok: false, host, statusLine, reason: `could not install skill: ${(error as Error).message}` };
  }
  spawnSync(host, ["mcp", "remove", "fleet"], { encoding: "utf8" });
  const result = spawnSync(host, add, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      host,
      skill,
      statusLine,
      reason: result.error?.message ?? result.stderr ?? result.stdout ?? "MCP registration failed",
    };
  }
  return {
    ok: true,
    host,
    skill,
    message: (result.stdout || result.stderr).trim(),
    statusLine,
  };
}
