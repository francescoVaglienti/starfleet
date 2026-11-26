import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { P, ensureDirs } from "./paths.js";
import type { ApplicationStack, BackendId, Policy, PolicyProject, Role } from "./types.js";

const BEGIN = "# >>> fleet managed — do not edit between markers >>>";
const END = "# <<< fleet managed <<<";

export const DEFAULT_POLICY: Policy = {
  defaults: {
    commands: [
      "ls", "cat", "head", "tail", "grep", "rg", "find", "fd", "wc", "sed", "awk",
      "echo", "pwd", "which", "file", "stat", "diff", "sort", "uniq", "tree",
      "mkdir", "touch", "cp", "mv",
      "git", "gh",
      "node", "npm", "npx", "pnpm", "yarn", "bun", "tsc", "tsx", "vitest", "jest",
      "python3", "pip3", "uv", "ruff", "black", "pytest", "poetry", "mypy",
      "cargo", "go", "make", "just",
      "docker", "supabase", "vercel", "curl", "jq", "vibemin",
    ],
    denyCommands: [
      "rm -rf /", "sudo", "shutdown", "reboot", "diskutil", "mkfs",
      "git push --force", "git reset --hard origin",
    ],
    write: true,
    network: true,
    applicationStack: {
      delivery: "a working application with end-to-end checks",
      presentation: "a README with setup, usage, and known limits",
    },
  },
  routing: {
    manage: ["codex", "claude", "copilot", "antigravity", "mimo", "pi"],
    implement: ["codex", "claude", "copilot", "antigravity", "mimo", "pi"],
    review: ["claude", "codex", "copilot", "antigravity", "mimo", "pi"],
    chore: ["codex", "claude", "copilot", "antigravity", "mimo", "pi"],
  },
  cooldown: { defaultMinutes: 30, failureMinutes: 10 },
  models: {
    claude: { model: "claude-opus-5", effort: "high" },
    codex: { model: "gpt-5.6-sol", effort: "high" },
    copilot: { model: "gpt-5.3-codex", effort: "high" },
    antigravity: { model: "gemini-3.8-flash-high", effort: "high" },
    mimo: { model: "mimo-v2.6-pro", effort: "high" },
    pi: { effort: "high" },
  },
  projects: {},
  notify: {
    on: ["exhausted", "failover", "permission.request", "run.error", "run.end"],
  },
  cleanup: {
    onDone: true,
    keepBranch: true,
    keepLedger: true,
    salvage: [".env*", "*.pem", "*.key", "credentials*"],
    salvageExclude: [".venv", "venv", "node_modules", "site-packages", "__pycache__", "dist", "build", ".next", ".git"],
  },
  vibemin: { required: true, maxAttempts: 500, timeout: 300 },
};

export function loadPolicy(): Policy {
  ensureDirs();
  if (!existsSync(P.policy)) {
    writeFileSync(P.policy, renderPolicy(DEFAULT_POLICY));
    return DEFAULT_POLICY;
  }
  try {
    const raw = YAML.parse(readFileSync(P.policy, "utf8")) as Partial<Policy> | null;
    if (!raw) return DEFAULT_POLICY;
    return {
      defaults: { ...DEFAULT_POLICY.defaults, ...(raw.defaults ?? {}) },
      routing: { ...DEFAULT_POLICY.routing, ...(raw.routing ?? {}) },
      cooldown: { ...DEFAULT_POLICY.cooldown, ...(raw.cooldown ?? {}) },
      models: { ...DEFAULT_POLICY.models, ...(raw.models ?? {}) },
      projects: raw.projects ?? {},
      notify: { ...DEFAULT_POLICY.notify, ...(raw.notify ?? {}) },
      cleanup: { ...DEFAULT_POLICY.cleanup, ...(raw.cleanup ?? {}) },
      vibemin: { ...DEFAULT_POLICY.vibemin, ...(raw.vibemin ?? {}) },
    };
  } catch (e) {
    throw new Error(`Could not parse ${P.policy}: ${(e as Error).message}`);
  }
}

function renderPolicy(p: Policy): string {
  return YAML.stringify(p);
}

export function savePolicy(p: Policy): void {
  ensureDirs();
  writeFileSync(P.policy, renderPolicy(p));
}

export function projectFor(policy: Policy, cwd: string): PolicyProject {
  // Longest matching prefix wins, so a subdirectory can tighten its parent.
  let best: PolicyProject = {};
  let bestLen = -1;
  for (const [path, cfg] of Object.entries(policy.projects)) {
    if ((cwd === path || cwd.startsWith(path.endsWith("/") ? path : path + "/")) && path.length > bestLen) {
      best = cfg;
      bestLen = path.length;
    }
  }
  return best;
}

export function commandsFor(policy: Policy, cwd: string): string[] {
  const proj = projectFor(policy, cwd);
  const set = new Set([...policy.defaults.commands, ...(proj.commands ?? [])]);
  for (const d of proj.denyCommands ?? []) set.delete(d);
  return [...set].sort();
}

export function routingFor(policy: Policy, cwd: string, role: Role): BackendId[] {
  return projectFor(policy, cwd).routing?.[role] ?? policy.routing[role];
}

export function modelFor(policy: Policy, cwd: string, backend: BackendId): { model?: string; effort?: string } {
  return { ...(policy.models[backend] ?? {}), ...(projectFor(policy, cwd).models?.[backend] ?? {}) };
}

export function applicationStackFor(policy: Policy, cwd: string): ApplicationStack {
  const override = projectFor(policy, cwd).applicationStack;
  if (override === false) return {};
  return { ...(policy.defaults.applicationStack || {}), ...(override ?? {}) };
}

export function vibeminFor(policy: Policy, cwd: string): Policy["vibemin"] {
  return { ...policy.vibemin, ...(projectFor(policy, cwd).vibemin ?? {}) };
}

// ---------------------------------------------------------------------------
// Compilers
// ---------------------------------------------------------------------------

export interface SyncReport {
  target: string;
  path: string;
  changed: boolean;
  detail: string;
}

function backup(path: string): void {
  if (!existsSync(path)) return;
  mkdirSync(P.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(path, join(P.backupDir, `${path.split("/").pop()}.${stamp}.bak`));
}

/** Claude: merge Bash(cmd:*) rules into permissions.allow, tracking what we own. */
export function syncClaude(policy: Policy, dryRun: boolean): SyncReport {
  const path = P.claudeSettings;
  const cfg = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : {};
  const perms = ((cfg["permissions"] as Record<string, unknown>) ?? {}) as {
    allow?: string[];
    deny?: string[];
    defaultMode?: string;
  };

  const managed = loadManaged();
  const prevOwned = new Set(managed.claude ?? []);
  const existing = (perms.allow ?? []).filter((e) => !prevOwned.has(e));
  const existingDeny = (perms.deny ?? []).filter((e) => !prevOwned.has(e));

  const wantAllow = policy.defaults.commands.map((c) => `Bash(${c}:*)`);
  const wantDeny = policy.defaults.denyCommands.map((c) => `Bash(${c}:*)`);

  const allow = [...new Set([...existing, ...wantAllow])].sort();
  const deny = [...new Set([...existingDeny, ...wantDeny])].sort();

  const next = {
    ...cfg,
    permissions: { ...perms, allow, deny },
  };
  const changed = JSON.stringify(cfg) !== JSON.stringify(next);
  if (!dryRun && changed) {
    backup(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
    managed.claude = [...wantAllow, ...wantDeny];
    saveManaged(managed);
  }
  return {
    target: "claude",
    path,
    changed,
    detail: `${wantAllow.length} allow, ${wantDeny.length} deny rules`,
  };
}

/** Codex: own a dedicated .rules file outright; touch config.toml only inside markers. */
export function syncCodex(policy: Policy, dryRun: boolean): SyncReport[] {
  const reports: SyncReport[] = [];

  const lines = [
    "# Generated by `fleet policy sync`. Edits here are overwritten.",
    "# Source of truth: ~/.fleet/policy.yaml",
    "",
    // Codex accepts exactly three decisions: allow | prompt | forbidden.
    ...policy.defaults.denyCommands.map(
      (c) =>
        `prefix_rule(pattern=[${c
          .split(/\s+/)
          .map((t) => JSON.stringify(t))
          .join(", ")}], decision="forbidden")`,
    ),
    ...policy.defaults.commands.map(
      (c) => `prefix_rule(pattern=[${JSON.stringify(c)}], decision="allow")`,
    ),
    "",
  ].join("\n");

  const rulesPath = P.codexRules;
  const prev = existsSync(rulesPath) ? readFileSync(rulesPath, "utf8") : "";
  const rulesChanged = prev !== lines;
  if (!dryRun && rulesChanged) {
    mkdirSync(dirname(rulesPath), { recursive: true });
    writeFileSync(rulesPath, lines);
  }
  reports.push({
    target: "codex:rules",
    path: rulesPath,
    changed: rulesChanged,
    // Deny rules are emitted first: Codex evaluates prefix rules in order.
    detail: `${policy.defaults.commands.length} allow, ${policy.defaults.denyCommands.length} deny`,
  });

  // Trusted projects + writable roots, inside a marked block so the rest of
  // config.toml (comments, ordering, hand-tuning) is never reformatted.
  const trusted = Object.entries(policy.projects).filter(([, c]) => c.trust === "trusted");
  const roots = Object.entries(policy.projects).flatMap(([p, c]) => [
    ...(c.write === false ? [] : [p]),
    ...(c.writableRoots ?? []),
  ]);
  const block = [
    BEGIN,
    ...(roots.length
      ? [
          "[sandbox_workspace_write]",
          `writable_roots = [${[...new Set(roots)].map((r) => JSON.stringify(r)).join(", ")}]`,
          `network_access = ${policy.defaults.network}`,
          "",
        ]
      : []),
    ...trusted.flatMap(([p]) => [`[projects.${JSON.stringify(p)}]`, 'trust_level = "trusted"', ""]),
    END,
  ].join("\n");

  const cfgPath = P.codexConfig;
  const cur = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : "";

  // TOML forbids a table being declared twice, so we cannot simply append our
  // block: any [sandbox_workspace_write] or [projects."..."] we emit must first
  // be removed from the hand-written part of the file. We take ownership of
  // exactly those tables and carry their existing values forward.
  const stripped = stripManagedTables(cur, new Set(Object.keys(policy.projects)));
  const inheritedRoots = extractWritableRoots(cur);
  const allRoots = [...new Set([...inheritedRoots, ...roots])];

  const finalBlock = [
    BEGIN,
    ...(allRoots.length
      ? [
          "[sandbox_workspace_write]",
          `writable_roots = [${allRoots.map((r) => JSON.stringify(r)).join(", ")}]`,
          `network_access = ${policy.defaults.network}`,
          "",
        ]
      : []),
    ...trusted.flatMap(([p]) => [`[projects.${JSON.stringify(p)}]`, 'trust_level = "trusted"', ""]),
    END,
  ].join("\n");

  const nextCfg = `${stripped.trimEnd()}\n\n${finalBlock}\n`;
  const cfgChanged = cur !== nextCfg && (trusted.length > 0 || allRoots.length > 0);
  if (!dryRun && cfgChanged) {
    backup(cfgPath);
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, nextCfg);
  }
  reports.push({
    target: "codex:config",
    path: cfgPath,
    changed: cfgChanged,
    detail: `${trusted.length} trusted project(s), ${allRoots.length} writable root(s)`,
  });

  return reports;
}

/**
 * Split a TOML file on top-level table headers and drop the tables fleet owns,
 * along with any previous fleet block. Everything else is preserved verbatim,
 * comments and ordering included.
 */
function stripManagedTables(toml: string, managedProjects: Set<string>): string {
  const withoutBlock = toml.replace(
    new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}\\n?`, "g"),
    "",
  );
  const lines = withoutBlock.split("\n");
  const out: string[] = [];
  let dropping = false;

  for (const line of lines) {
    const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/);
    if (header) {
      const name = header[1]!.trim();
      if (name === "sandbox_workspace_write") {
        dropping = true;
      } else if (name.startsWith("projects.")) {
        // [projects."/some/path"] — compare the unquoted path.
        const path = name.slice("projects.".length).replace(/^"|"$/g, "");
        dropping = managedProjects.has(path);
      } else {
        dropping = false;
      }
    }
    if (!dropping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Read writable_roots out of an existing config so we never silently drop them. */
function extractWritableRoots(toml: string): string[] {
  const m = toml.match(/^\s*writable_roots\s*=\s*\[([\s\S]*?)\]/m);
  if (!m?.[1]) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

/** Copilot: per-location tool_approvals; fleet owns only the locations it added. */
export function syncCopilot(policy: Policy, dryRun: boolean): SyncReport {
  const path = P.copilotPermissions;
  const cfg = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as { locations?: Record<string, unknown> })
    : {};
  const locations = { ...(cfg.locations ?? {}) };

  const managed = loadManaged();
  const owned = new Set(managed.copilot ?? []);
  for (const key of owned) {
    if (!(key in policy.projects)) delete locations[key];
  }

  const nowOwned: string[] = [];
  for (const [proj, pcfg] of Object.entries(policy.projects)) {
    const cmds = [...new Set([...policy.defaults.commands, ...(pcfg.commands ?? [])])]
      .filter((c) => !(pcfg.denyCommands ?? []).includes(c))
      .sort();
    const approvals: unknown[] = [{ kind: "commands", commandIdentifiers: cmds }];
    if (pcfg.write !== false) approvals.unshift({ kind: "write" });
    locations[proj] = { tool_approvals: approvals };
    nowOwned.push(proj);
  }

  const next = { ...cfg, locations };
  const changed = JSON.stringify(cfg) !== JSON.stringify(next);
  if (!dryRun && changed) {
    backup(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
    managed.copilot = nowOwned;
    saveManaged(managed);
  }
  return {
    target: "copilot",
    path,
    changed,
    detail: `${Object.keys(policy.projects).length} location(s)`,
  };
}

export function syncAll(policy: Policy, dryRun: boolean): SyncReport[] {
  return [syncClaude(policy, dryRun), ...syncCodex(policy, dryRun), syncCopilot(policy, dryRun)];
}

interface Managed {
  claude?: string[];
  copilot?: string[];
}

function loadManaged(): Managed {
  if (!existsSync(P.managed)) return {};
  try {
    return JSON.parse(readFileSync(P.managed, "utf8")) as Managed;
  } catch {
    return {};
  }
}

function saveManaged(m: Managed): void {
  ensureDirs();
  writeFileSync(P.managed, JSON.stringify(m, null, 2) + "\n");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
