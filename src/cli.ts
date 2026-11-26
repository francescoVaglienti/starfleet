import type { Policy } from "./types.js";
import { readFileSync, existsSync, rmSync, readdirSync, statSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";
import { ensureDirs, P, piSessionDir } from "./paths.js";
import { loadPolicy, savePolicy, syncAll, DEFAULT_POLICY, projectFor, modelFor } from "./policy.js";
import {
  clearMute,
  configureNotify,
  emit,
  readEvents,
  readMute,
  setMute,
  tailEvents,
} from "./events.js";
import { loadHealth, cooldownRemaining, clearCooldown, clearAll } from "./health.js";
import { installedBackends, BACKENDS } from "./backends/index.js";
import {
  createLedger,
  listLedgers,
  readLedger,
  writeLedger,
  appendHandoff,
} from "./ledger.js";
import { dispatch, resolveChain } from "./run.js";
import {
  ensureWorktrees,
  commitsAhead,
  slugify,
  dirtyFiles,
  listWorktrees,
  repoRoot,
  cleanupTaskWorktrees,
  inspectTaskCleanup,
  branchPreservation,
  git,
  isGitRepo,
} from "./worktree.js";
import { MCP_VERSION, startMcpServer } from "./mcp.js";
import { runCompletionGate } from "./vibemin.js";
import { setupHost } from "./setup.js";
import { activeRuns, renderStatusline } from "./statusline.js";
import { BACKEND_IDS, ROLES, type BackendId, type Ledger, type Role, type WorktreeRef } from "./types.js";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

interface Flags {
  _: string[];
  [k: string]: string | boolean | string[] | undefined;
}

function parseArgs(argv: string[]): Flags {
  const options: Record<string, { type: "string" | "boolean"; short?: string }> = {};
  for (const name of ["all", "dry-run", "force", "help", "json", "purge-ledger", "read-only", "version"]) {
    options[name] = { type: "boolean" };
  }
  for (const name of ["backend", "base", "branch", "hours", "kind", "minutes", "older-than", "path", "project", "prompt", "repo", "role", "status", "task", "ticket", "timeout", "title"]) {
    options[name] = { type: "string" };
  }
  for (const name of ["h", "m", "n"]) options[name] = { type: "string", short: name };
  const parsed = parseNodeArgs({ args: argv, options, allowPositionals: true, strict: true });
  return { _: parsed.positionals, ...parsed.values };
}

const s = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function durationValue(value: Flags[string], label: string): number | string {
  if (value === undefined) return 0;
  if (typeof value !== "string" || value.trim() === "") {
    return `Mute ${label} must be a non-negative number.`;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return `Mute ${label} must be a non-negative number.`;
  }
  return parsed;
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.ceil(Math.max(0, ms) / 60_000);
  if (totalMinutes === 0) return "less than 1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : ""].filter(Boolean).join(" ");
}

const HELP = `${C.bold("fleet")} — one ledger, six coding agents, automatic failover.

${C.bold("TASKS")}
  fleet task new <id> --title <t> --project <path> [--ticket N] [--kind task|fix|feature]
                 [--base <ref>]     Create ledger + isolated worktree on a conventional branch.
                                    --base branches from <ref> instead of the project default;
                                    use it when the task builds on unmerged local commits.
  fleet task list                   All tasks, their status and branches
  fleet task show <id>              Print a task's ledger
  fleet task rm <id> [--force] [--purge-ledger] Remove a task's worktree(s)
  fleet task done <id>              Mark complete

${C.bold("CLEANUP")}
  fleet prune [--dry-run] [--status done|complete] [--older-than <days>]
                                    Sweep every task and reclaim disk space

${C.bold("RUNNING")}
  fleet run <id> --prompt <text> [--role manage|implement|review|chore]
                 [--backend claude|codex|copilot|antigravity|mimo|pi] [--read-only] [--timeout <min>]
                                    Dispatch, failing over when a backend is spent
  fleet delegate <id>              Alias for fleet run
  fleet takeover <id> [--prompt <t>] Continue a task on the best backend that is NOT exhausted.
                                    This is what you run when Claude runs out.
  fleet route <role> [--project <path>] Show the project-aware backend and model chain

${C.bold("VISIBILITY")}
  fleet status [--json]             Backend health + cooldowns + active tasks
  fleet watch [--task <id>] [--all] Live tail of the unified event bus
  fleet log [--task <id>] [-n N]    Recent events
  fleet mute [-h N] [-m N]          Mute notifications indefinitely or for a duration
             [--hours N] [--minutes N]
  fleet unmute                      Resume notifications immediately everywhere
  fleet worktrees --project <path>  Every worktree, branch and dirty state

${C.bold("POLICY")}
  fleet policy show                 Print the effective policy
  fleet policy sync [--dry-run]     Compile policy.yaml into all three vendors' native formats
  fleet policy edit                 Open policy.yaml in $EDITOR
  fleet clear-cooldown <backend|all>

${C.bold("INTEGRATION")}
  fleet mcp                         Run Fleet's stdio MCP server
  fleet setup <codex|claude|all> [--dry-run] Install the MCP server and Fleet skill
  fleet statusline                  Render the Claude status bar (normally called by Claude)
  fleet init                        Create ~/.fleet, seed policy, print next steps
`;

export async function main(argv: string[]): Promise<number> {
  let f: Flags;
  try {
    f = parseArgs(argv);
    if (f.timeout !== undefined && (!Number.isFinite(Number(f.timeout)) || Number(f.timeout) <= 0)) {
      throw new Error("--timeout must be a positive number of minutes.");
    }
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  const cmd = f._[0];
  const sub = f._[1];

  if (f.version) {
    process.stdout.write(`fleet ${MCP_VERSION}\n`);
    return 0;
  }
  if (!cmd || cmd === "help" || f["help"]) {
    process.stdout.write(HELP);
    return 0;
  }

  ensureDirs();

  if (cmd === "mcp") {
    await startMcpServer();
    // connect() resolves once the transport is wired; the server lives on
    // stdio, so we must not fall through to process.exit().
    await new Promise<never>(() => {});
    return 0;
  }
  if (cmd === "statusline") {
    let payload: Record<string, unknown> = {};
    try {
      const input = readFileSync(0, "utf8").trim();
      if (input) payload = JSON.parse(input) as Record<string, unknown>;
    } catch {
      // Status bars must stay useful even when a client sends a partial payload.
    }
    process.stdout.write(`${renderStatusline(payload)}\n`);
    return 0;
  }

  const policy = loadPolicy();
  configureNotify(policy.notify);

  switch (cmd) {
    case "init":
      return cmdInit();
    case "status":
      return cmdStatus();
    case "mute":
      return cmdMute(f);
    case "unmute":
      return cmdUnmute();
    case "task":
      return cmdTask(sub, f);
    case "run":
    case "delegate":
      return cmdRun(f, false);
    case "takeover":
      return cmdRun(f, true);
    case "route":
      return cmdRoute(f);
    case "watch":
      return cmdWatch(f);
    case "log":
      return cmdLog(f);
    case "worktrees":
      return cmdWorktrees(f);
    case "prune":
      return cmdPrune(f);
    case "policy":
      return cmdPolicy(sub, f);
    case "clear-cooldown":
      return cmdClearCooldown(sub);
    case "setup":
      return cmdSetup(sub, f);
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      return 1;
  }

  // -------------------------------------------------------------------------

  function cmdInit(): number {
    if (!existsSync(P.policy)) savePolicy(DEFAULT_POLICY);
    const installed = installedBackends();
    process.stdout.write(
      `${C.green("fleet initialised")}\n` +
        `  state    ${P.home}\n` +
        `  policy   ${P.policy}\n` +
        `  events   ${P.events}\n\n` +
        `Backends detected: ${installed.join(", ") || C.red("none")}\n` +
        (installed.length < 3
          ? C.yellow(`  missing: ${BACKEND_IDS.filter((b) => !installed.includes(b)).join(", ")}\n`)
          : "") +
        `\nNext:\n  1. Edit ${P.policy} (add your projects)\n` +
        `  2. fleet policy sync --dry-run\n` +
        `  3. fleet task new my-feature --title "..." --project /path/to/repo\n`,
    );
    return 0;
  }

  function cmdSetup(host: string | undefined, f: Flags): number {
    if (!host || !["codex", "claude", "all"].includes(host)) {
      process.stderr.write("Usage: fleet setup <codex|claude|all> [--dry-run]\n");
      return 1;
    }
    const hosts: Array<"codex" | "claude"> = host === "all"
      ? ["codex", "claude"]
      : [host as "codex" | "claude"];
    let code = 0;
    for (const selected of hosts) {
      const result = setupHost(selected, f["dry-run"] === true);
      process.stdout.write(`${selected}: ${result.ok ? C.green("ready") : C.red("failed")}\n`);
      for (const detail of [result.skill, result.command, result.message, result.statusLine, result.reason]) {
        if (detail) process.stdout.write(`  ${detail.trim()}\n`);
      }
      if (!result.ok) code = 1;
    }
    return code;
  }

  function cmdStatus(): number {
    const health = loadHealth();
    const installed = installedBackends();
    if (f.json === true) {
      process.stdout.write(JSON.stringify({
        schemaVersion: 1,
        paths: { events: P.events, ledgerDir: P.ledgerDir },
        runs: activeRuns(),
        backends: BACKEND_IDS.map((id) => ({
          id,
          installed: installed.includes(id),
          model: policy.models[id]?.model ?? null,
          lastResolvedModel: health[id]?.lastResolvedModel ?? null,
          effort: policy.models[id]?.effort ?? null,
          cooldownUntil: cooldownRemaining(id) > 0 ? health[id]?.cooldownUntil ?? null : null,
          reason: health[id]?.reason ?? null,
        })),
        routing: policy.routing,
        tasks: listLedgers().map(({ meta }) => ({ id: meta.id, title: meta.title, status: meta.status })),
      }) + "\n");
      return 0;
    }
    const mute = readMute();
    if (mute) {
      const duration = mute.until
        ? `${formatDuration(new Date(mute.until).getTime() - Date.now())} remaining`
        : "indefinite";
      process.stdout.write(`${C.bold("NOTIFICATIONS")}  ${C.yellow(`muted · ${duration}`)}\n\n`);
    }
    process.stdout.write(`${C.bold("BACKENDS")}\n`);
    for (const id of BACKEND_IDS) {
      if (!installed.includes(id)) {
        process.stdout.write(`  ${id.padEnd(12)} ${C.dim("not installed")}\n`);
        continue;
      }
      const cd = cooldownRemaining(id);
      const h = health[id];
      if (cd > 0) {
        process.stdout.write(
          `  ${id.padEnd(12)} ${C.red(`cooldown ${Math.ceil(cd / 60_000)}m`)} ${C.dim(h?.reason ?? "")}\n`,
        );
      } else {
        const configuredModel = policy.models[id]?.model ?? "backend default";
        const model = configuredModel + (h?.lastResolvedModel ? ` · last resolved ${h.lastResolvedModel}` : "");
        const version = BACKENDS[id].version?.();
        process.stdout.write(
          `  ${id.padEnd(12)} ${C.green("ok")} ${C.dim(`${model}${version ? ` · v${version}` : ""}${h?.lastRunAt ? ` · last ${h.lastRunAt.slice(0, 16)}` : ""}`)}\n`,
        );
      }
    }
    process.stdout.write(`\n${C.bold("ROUTING")}\n`);
    for (const role of ROLES) {
      const { chain } = resolveChain({ policy, role });
      process.stdout.write(
        `  ${role.padEnd(12)} ${chain.length ? chain.join(" → ") : C.red("nothing available")}\n`,
      );
    }
    const tasks = listLedgers();
    process.stdout.write(`\n${C.bold("TASKS")}\n`);
    if (!tasks.length) process.stdout.write(`  ${C.dim("(none)")}\n`);
    for (const t of tasks) {
      const branches = (t.meta.worktrees ?? []).map((w) => w.branch).join(", ");
      const dirty = (t.meta.worktrees ?? []).reduce((n, w) => n + dirtyFiles(w.path).length, 0);
      process.stdout.write(
        `  ${t.meta.id.padEnd(26)} ${t.meta.status.padEnd(12)} ${C.cyan(branches || "no worktree")}` +
          `${dirty ? C.yellow(`  ${dirty} dirty`) : ""}\n`,
      );
    }
    return 0;
  }

  function cmdMute(f: Flags): number {
    const hours = durationValue(f["hours"] ?? f["h"], "hours");
    const minutes = durationValue(f["minutes"] ?? f["m"], "minutes");
    if (typeof hours === "string" || typeof minutes === "string") {
      process.stderr.write(`${typeof hours === "string" ? hours : minutes}\n`);
      return 1;
    }
    const hasDuration =
      f["hours"] !== undefined || f["h"] !== undefined || f["minutes"] !== undefined || f["m"] !== undefined;
    const durationMs = (hours * 60 + minutes) * 60_000;
    if (hasDuration && (!Number.isFinite(durationMs) || durationMs <= 0)) {
      process.stderr.write("Mute duration must be greater than zero.\n");
      return 1;
    }
    const until = hasDuration ? new Date(Date.now() + durationMs) : null;
    if (until && !Number.isFinite(until.getTime())) {
      process.stderr.write("Mute duration is too large.\n");
      return 1;
    }
    const replacing = readMute() !== null;
    const state = setMute(until);
    process.stdout.write(
      `${C.green(replacing ? "notification mute replaced" : "notifications muted")} across all running fleet instances\n` +
        (state.until
          ? `  until  ${new Date(state.until).toLocaleString()} (${formatDuration(durationMs)})\n`
          : `  until  indefinite\n`) +
        `  undo   fleet unmute\n`,
    );
    return 0;
  }

  function cmdUnmute(): number {
    if (clearMute()) {
      process.stdout.write(`${C.green("notifications unmuted")} immediately across all running fleet instances\n`);
    } else {
      process.stdout.write("notifications were not muted\n");
    }
    return 0;
  }

  function cmdTask(action: string | undefined, f: Flags): number {
    if (action === "list" || action === undefined) {
      for (const t of listLedgers()) {
        process.stdout.write(
          `${t.meta.id.padEnd(26)} ${t.meta.status.padEnd(12)} ${t.meta.title}\n` +
            (t.meta.worktrees ?? [])
              .map((w) => `${" ".repeat(26)} ${C.cyan(w.branch)}  ${C.dim(w.path)}\n`)
              .join(""),
        );
      }
      return 0;
    }

    if (action === "new") {
      const id = f._[2];
      if (!id) {
        process.stderr.write("Usage: fleet task new <id> --title <t> --project <path>\n");
        return 1;
      }
      if (readLedger(id)) {
        process.stderr.write(`Task "${id}" already exists.\n`);
        return 1;
      }
      const project = s(f["project"]) ?? process.cwd();
      const title = s(f["title"]) ?? id;
      const l = createLedger({ id, title, repo: project });
      try {
        const wts = ensureWorktrees({
          policy,
          projectKey: project,
          taskId: id,
          spec: { kind: s(f["kind"]), ticket: s(f["ticket"]), slug: slugify(title) },
          base: s(f["base"]),
        });
        l.meta.worktrees = wts;
        l.meta.ticket = s(f["ticket"]);
        l.meta.kind = s(f["kind"]);
        l.meta.status = "in_progress";
        writeLedger(l);
        process.stdout.write(`${C.green("created")} ${id}\n  ledger ${l.path}\n`);
        for (const w of wts) {
          process.stdout.write(`  ${C.cyan(w.branch)}\n    ${w.path}  ${C.dim(`(from ${w.base})`)}\n`);
          // Loud, because it is silent otherwise: branching from the default
          // base while sitting on a branch that is ahead of it hands the
          // agent a tree without the very commits the task builds on.
          const ahead = commitsAhead(w.repo, w.base);
          if (ahead) {
            process.stdout.write(
              C.yellow(
                `    warning: ${ahead.branch} is ${ahead.count} commit(s) ahead of ${w.base}; ` +
                  `the worktree does NOT include them.\n`,
              ) + C.dim(`    re-create with --base ${ahead.branch} if the task depends on that work.\n`),
            );
          }
        }
      } catch (e) {
        process.stdout.write(
          `${C.yellow("ledger created")} ${l.path}\n${C.red("worktree failed")}: ${(e as Error).message}\n`,
        );
        return 1;
      }
      return 0;
    }

    if (action === "show") {
      const id = f._[2];
      const l = id ? readLedger(id) : null;
      if (!l) {
        process.stderr.write(`No such task.\n`);
        return 1;
      }
      process.stdout.write(readFileSync(l.path, "utf8"));
      return 0;
    }

    if (action === "done") {
      const id = f._[2];
      const l = id ? readLedger(id) : null;
      if (!l) {
        process.stderr.write("No such task.\n");
        return 1;
      }
      const gate = runCompletionGate(policy, l);
      if (!gate.ok) {
        process.stderr.write(`${C.red("completion refused")}: ${gate.reason}\n`);
        return 1;
      }
      l.meta.status = "done";
      writeLedger(l);
      appendHandoff(l.meta.id, "marked done after mandatory Vibemin gate");
      process.stdout.write(`${C.green("done")} ${l.meta.id} · Vibemin passed\n`);
      
      if (policy.cleanup.onDone) {
        const res = cleanupTaskWorktrees(policy, l.meta.id, false);
        if (res.ok) {
          process.stdout.write(`  ${C.green("auto-cleaned worktrees")}\n`);
          printSalvage(res.salvaged ?? []);
          printKeptBranches(res.keptBranches ?? []);
          if (!policy.cleanup.keepLedger) {
            const current = readLedger(l.meta.id);
            if (current) {
              const orphan = inspectOrphan(current, policy);
              if (orphan.ok) {
                try {
                  pruneOrphanAdmin(current);
                  purgeLedgerAndLogs(current);
                  process.stdout.write(`  ${C.dim("purged ledger and logs (cleanup.keepLedger: false)")}\n`);
                } catch (error) {
                  process.stdout.write(
                    `  ${C.yellow("kept ledger and logs")} R8: artifact purge failed: ${(error as Error).message}; fix permissions and retry\n`,
                  );
                }
              } else {
                process.stdout.write(`  ${C.yellow("kept ledger and logs")} ${orphan.reason}\n`);
              }
            }
          }
        } else {
          process.stdout.write(`  ${C.yellow("auto-cleanup refused")}: ${res.reason}\n`);
        }
      }
      return 0;
    }

    if (action === "rm") {
      const id = f._[2];
      if (!id) {
        process.stderr.write("Usage: fleet task rm <id> [--force] [--purge-ledger]\n");
        return 1;
      }
      const force = f["force"] === true;
      const l = readLedger(id);
      if (!l) {
        process.stderr.write("No such task.\n");
        return 1;
      }

      if ((l.meta.worktrees ?? []).length === 0 && f["purge-ledger"]) {
        try {
          purgeLedgerAndLogs(l);
          process.stdout.write(`${C.green("purged ledger and logs")} for ${id}\n`);
          return 0;
        } catch (error) {
          process.stderr.write(`${C.red("ledger/log purge failed")}: ${(error as Error).message}\n`);
          return 1;
        }
      }
      
      const res = cleanupTaskWorktrees(policy, id, force);
      if (!res.ok) {
        process.stderr.write(`${C.red("refused")} ${res.reason}\n`);
        return 1;
      }
      
      process.stdout.write(`${C.green("removed worktrees")} for ${id}\n`);
      printSalvage(res.salvaged ?? []);
      printKeptBranches(res.keptBranches ?? []);

      if (f["purge-ledger"]) {
        try {
          purgeLedgerAndLogs(l);
          process.stdout.write(`  ${C.dim("purged ledger and logs")}\n`);
        } catch (error) {
          process.stderr.write(
            `${C.red("worktrees removed, but ledger/log purge failed")}: ${(error as Error).message}\n  Fix permissions and rerun fleet task rm ${id} --purge-ledger.\n`,
          );
          return 1;
        }
      }
      return 0;
    }

    process.stderr.write(`Unknown: fleet task ${action}\n`);
    return 1;
  }

  async function cmdRun(f: Flags, takeover: boolean): Promise<number> {
    const id = f._[1];
    if (!id) {
      process.stderr.write(`Usage: fleet ${takeover ? "takeover" : "run"} <task-id> --prompt <text>\n`);
      return 1;
    }
    const l = readLedger(id);
    if (!l) {
      process.stderr.write(`No such task "${id}".\n`);
      return 1;
    }

    const role = (s(f["role"]) ?? (takeover ? "manage" : "implement")) as Role;
    const prompt =
      s(f["prompt"]) ??
      (takeover
        ? "Continue this task. Read the ledger, pick up at the top of the Next queue, and keep " +
          "going until you finish it or hit a genuine blocker. Update the ledger as you go."
        : undefined);
    if (!prompt) {
      process.stderr.write("--prompt is required.\n");
      return 1;
    }

    // On takeover the previous manager is presumed spent, so we exclude it.
    let backend = s(f["backend"]) as BackendId | undefined;
    if (takeover && !backend) {
      const { chain, skipped } = resolveChain({ policy, role, ledger: l });
      if (!chain.length) {
        process.stderr.write(
          `${C.red("Every backend is exhausted or unavailable.")}\n` +
            skipped.map((x) => `  ${x.backend}: ${x.reason}\n`).join(""),
        );
        return 1;
      }
      backend = chain[0];
      process.stdout.write(`${C.bold("takeover")} → ${C.cyan(backend!)}\n`);
    }

    const timeoutMin = Number(s(f["timeout"]) ?? 30);
    process.stdout.write(C.dim(`task ${id} · role ${role}\n`));

    const { result, attempts } = await dispatch({
      taskId: id,
      task: prompt,
      role,
      policy,
      backend,
      readOnly: f["read-only"] === true,
      timeoutMs: timeoutMin * 60_000,
      onEvent: (type, msg, be) => {
        if (type === "tool.use") process.stdout.write(C.dim(`  ${be} · ${msg.slice(0, 100)}\n`));
        else if (type === "agent.text") process.stdout.write(`${C.cyan(be)} ${msg.slice(0, 400)}\n`);
        else if (type === "run.error") process.stdout.write(C.red(`  ${be} · ${msg.slice(0, 200)}\n`));
      },
    });

    process.stdout.write(`\n${C.bold("routing")}\n`);
    for (const a of attempts) {
      const colour = a.outcome === "ok" ? C.green : a.outcome === "skipped" ? C.dim : C.yellow;
      process.stdout.write(`  ${a.backend.padEnd(12)} ${colour(a.outcome)} ${C.dim(a.detail ?? "")}\n`);
    }
    if (!result) {
      process.stdout.write(C.red("\nNo backend took the run.\n"));
      return 1;
    }

    if (result.finalMessage.trim()) {
      process.stdout.write(`\n${C.bold("final")}\n${result.finalMessage.trim()}\n`);
    }
    process.stdout.write(C.dim(`\nlog ${result.logPath}\n`));

    return result.exitCode === 0 && !result.failureReason ? 0 : 1;
  }

  function cmdRoute(f: Flags): number {
    const role = (f._[1] ?? "implement") as Role;
    const project = s(f["project"]) ?? process.cwd();
    const { chain, skipped } = resolveChain({ policy, role, project });
    process.stdout.write(
      `role ${C.bold(role)}\n  would use  ${chain[0] ? C.green(chain[0]) : C.red("nothing available")}\n` +
        `  chain      ${chain.join(" → ") || "(none)"}\n` +
        chain.map((backend) => {
          const preference = modelFor(policy, project, backend);
          return `  ${backend.padEnd(12)} ${preference.model ?? "backend default"} ${preference.effort ?? ""}\n`;
        }).join("") +
        `  skipped    ${skipped.map((x) => `${x.backend} (${x.reason})`).join(", ") || "none"}\n`,
    );
    return 0;
  }

  async function cmdWatch(f: Flags): Promise<number> {
    const taskId = s(f["task"]);
    const all = f["all"] === true;
    process.stdout.write(
      C.dim(`watching ${P.events}${taskId ? ` · task ${taskId}` : ""}${all ? " · all events" : ""}\n`),
    );
    const noisy = new Set(["agent.reasoning", "tool.result"]);
    await tailEvents(
      (e) => {
        if (!all && noisy.has(e.type)) return;
        const t = e.ts.slice(11, 19);
        const colour =
          e.type === "run.error" || e.type === "exhausted"
            ? C.red
            : e.type === "failover"
              ? C.yellow
              : e.type === "run.end"
                ? C.green
                : e.type === "agent.text"
                  ? C.cyan
                  : C.dim;
        process.stdout.write(
          `${C.dim(t)} ${e.backend.padEnd(12)} ${colour(e.type.padEnd(16))} ${C.dim(e.taskId.padEnd(18))} ${(e.msg ?? "").slice(0, 120)}\n`,
        );
      },
      { taskId },
    );
    return 0;
  }

  async function cmdLog(f: Flags): Promise<number> {
    const limit = Number(s(f["n"]) ?? 50);
    const evs = await readEvents({ taskId: s(f["task"]), limit });
    for (const e of evs) {
      process.stdout.write(
        `${e.ts.slice(0, 19).replace("T", " ")} ${e.backend.padEnd(12)} ${e.type.padEnd(16)} ${e.taskId.padEnd(18)} ${(e.msg ?? "").slice(0, 140)}\n`,
      );
    }
    return 0;
  }

  function cmdWorktrees(f: Flags): number {
    const project = s(f["project"]) ?? process.cwd();
    const cfg = projectFor(policy, project);
    const repos = cfg.repos?.length
      ? cfg.repos.map((r) => (r.startsWith("/") ? r : `${project}/${r}`))
      : [repoRoot(project) ?? project];
    for (const r of repos) {
      process.stdout.write(`${C.bold(basename(r))} ${C.dim(r)}\n`);
      const wts = listWorktrees(r);
      if (!wts.length) process.stdout.write(`  ${C.dim("(not a git repo / no worktrees)")}\n`);
      for (const w of wts) {
        const d = dirtyFiles(w.path);
        process.stdout.write(
          `  ${C.cyan(w.branch.padEnd(44))} ${d.length ? C.yellow(`${d.length} dirty`) : C.green("clean")}  ${C.dim(w.path)}\n`,
        );
      }
      process.stdout.write("\n");
    }
    return 0;
  }

  function cmdPolicy(action: string | undefined, f: Flags): number {
    if (action === "show") {
      process.stdout.write(readFileSync(P.policy, "utf8"));
      return 0;
    }
    if (action === "edit") {
      const editor = process.env.EDITOR ?? "vi";
      spawnSync(editor, [P.policy], { stdio: "inherit" });
      return 0;
    }
    if (action === "sync") {
      const dry = f["dry-run"] === true;
      const reports = syncAll(policy, dry);
      process.stdout.write(dry ? C.yellow("DRY RUN — nothing written\n\n") : "");
      for (const r of reports) {
        const mark = r.changed ? C.green("write") : C.dim("unchanged");
        process.stdout.write(`  ${r.target.padEnd(14)} ${mark}  ${C.dim(r.detail)}\n${" ".repeat(18)}${C.dim(r.path)}\n`);
      }
      if (!dry) {
        emit({
          runId: "-",
          taskId: "-",
          backend: "fleet",
          type: "policy.sync",
          msg: `synced ${reports.filter((r) => r.changed).length} target(s)`,
        });
        process.stdout.write(`\n${C.dim(`backups in ${P.backupDir}`)}\n`);
      }
      return 0;
    }
    process.stderr.write("Usage: fleet policy show|sync|edit\n");
    return 1;
  }

  function cmdClearCooldown(which: string | undefined): number {
    if (which === "all") {
      clearAll();
      process.stdout.write(`${C.green("cleared")} all cooldowns\n`);
      return 0;
    }
    if (which && (BACKEND_IDS as string[]).includes(which)) {
      clearCooldown(which as BackendId);
      process.stdout.write(`${C.green("cleared")} ${which}\n`);
      return 0;
    }
    process.stderr.write(`Usage: fleet clear-cooldown <${BACKEND_IDS.join("|")}|all>\n`);
    return 1;
  }
  function cmdPrune(f: Flags): number {
    const dry = f["dry-run"] === true;
    const reqStatus = s(f["status"]);
    if (reqStatus && reqStatus !== "done" && reqStatus !== "complete") {
      process.stderr.write("--status must be done or complete\n");
      return 1;
    }
    const olderRaw = s(f["older-than"]);
    const olderThan = olderRaw === undefined ? undefined : Number(olderRaw);
    if (olderThan !== undefined && (!Number.isFinite(olderThan) || olderThan < 0)) {
      process.stderr.write("--older-than must be a non-negative number of days\n");
      return 1;
    }
    let reclaimedBytes = 0;
    process.stdout.write(`${C.bold("pruning tasks")}${dry ? C.yellow("  DRY RUN") : ""}\n\n`);

    for (const l of listLedgers()) {
      if (reqStatus && reqStatus !== l.meta.status) {
        process.stdout.write(`  ${l.meta.id.padEnd(26)} ${C.dim("filtered")} status is ${l.meta.status}\n`);
        continue;
      }
      if (olderThan !== undefined) {
        const ageDays = (Date.now() - new Date(l.meta.updated).getTime()) / (1000 * 3600 * 24);
        if (!Number.isFinite(ageDays) || ageDays < olderThan) {
          const age = Number.isFinite(ageDays) ? `${Math.round(ageDays)}d` : "unknown";
          process.stdout.write(`  ${l.meta.id.padEnd(26)} ${C.dim("filtered")} age ${age} < ${olderThan}d\n`);
          continue;
        }
      }

      if (l.meta.status === "in_progress") {
        process.stdout.write(
          `  ${l.meta.id.padEnd(26)} ${C.yellow("refused")} R2: task is in_progress; mark it done or use fleet task rm --force\n`,
        );
        continue;
      }

      const recorded = l.meta.worktrees ?? [];
      if (recorded.some((worktree) => !validWorktreeRef(worktree))) {
        process.stdout.write(
          `  ${l.meta.id.padEnd(26)} ${C.yellow("refused")} R6: ledger contains an invalid worktree record; repair the ledger before retrying\n`,
        );
        continue;
      }
      const active = recorded.filter((worktree) => existsSync(worktree.path));
      if (active.length > 0) {
        const sizes = new Map(active.map((worktree) => [worktree.path, dirSize(worktree.path)]));
        const sizeBytes = [...sizes.values()].reduce((total, size) => total + size, 0);
        const inspection = inspectTaskCleanup(policy, l.meta.id, false);
        if (!inspection.ok) {
          process.stdout.write(
            `  ${l.meta.id.padEnd(26)} ${C.yellow("refused")} ${inspection.reason}; reclaim 0 B (${formatBytes(sizeBytes)} candidate)\n`,
          );
          continue;
        }
        if (dry) {
          process.stdout.write(
            `  ${l.meta.id.padEnd(26)} ${C.green("eligible")} would remove ${active.length} worktree(s), reclaim ${formatBytes(sizeBytes)}\n`,
          );
          printPlannedSalvage(inspection.salvage);
        } else {
          const res = cleanupTaskWorktrees(policy, l.meta.id, false);
          if (!res.ok) {
            const partialBytes = (res.removedWorktrees ?? []).reduce(
              (total, path) => total + (sizes.get(path) ?? 0),
              0,
            );
            reclaimedBytes += partialBytes;
            process.stdout.write(
              `  ${l.meta.id.padEnd(26)} ${C.yellow("refused")} ${res.reason}` +
                (partialBytes > 0 ? `; partially reclaimed ${formatBytes(partialBytes)}` : "") +
                "\n",
            );
            continue;
          }
          reclaimedBytes += sizeBytes;
          process.stdout.write(
            `  ${l.meta.id.padEnd(26)} ${C.green("cleaned")} ${active.length} worktree(s), reclaimed ${formatBytes(sizeBytes)}\n`,
          );
          printSalvage(res.salvaged ?? []);
          printKeptBranches(res.keptBranches ?? []);
        }
      } else {
        const orphan = inspectOrphan(l, policy);
        if (!orphan.ok) {
          process.stdout.write(`  ${l.meta.id.padEnd(26)} ${C.yellow("refused")} ${orphan.reason}\n`);
          continue;
        }
        let sizeBytes: number;
        try {
          sizeBytes = taskArtifactSize(l);
        } catch (error) {
          process.stdout.write(
            `  ${l.meta.id.padEnd(26)} ${C.yellow("refused")} R8: cannot inspect ledger/logs: ${(error as Error).message}; fix permissions and retry\n`,
          );
          continue;
        }
        if (dry) {
          process.stdout.write(
            `  ${l.meta.id.padEnd(26)} ${C.green("eligible")} would purge ledger/logs, reclaim ${formatBytes(sizeBytes)}\n`,
          );
        } else {
          try {
            pruneOrphanAdmin(l);
            purgeLedgerAndLogs(l);
            reclaimedBytes += sizeBytes;
            process.stdout.write(
              `  ${l.meta.id.padEnd(26)} ${C.green("purged")} ledger/logs, reclaimed ${formatBytes(sizeBytes)}\n`,
            );
          } catch (error) {
            process.stdout.write(
              `  ${l.meta.id.padEnd(26)} ${C.yellow("refused")} R8: artifact purge failed: ${(error as Error).message}; fix permissions and retry\n`,
            );
          }
        }
      }
    }

    process.stdout.write(
      dry
        ? `\n${C.bold("Dry run:")} no files changed\n`
        : `\n${C.green("Reclaimed:")} ${formatBytes(reclaimedBytes)}\n`,
    );

    return 0;
  }

  function printPlannedSalvage(files: Array<{ source: string; destination: string }>): void {
    for (const file of files) {
      process.stdout.write(`    ${C.cyan("would salvage")} ${file.source} -> ${file.destination}\n`);
    }
  }

  function printSalvage(files: Array<{ source: string; destination: string }>): void {
    for (const file of files) process.stdout.write(`  ${C.cyan("salvaged")} ${file.source} -> ${file.destination}\n`);
  }

  function printKeptBranches(branches: string[]): void {
    for (const branch of branches) process.stdout.write(`  ${C.dim("kept branch")} ${branch}\n`);
  }
}

function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let size = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) size += dirSize(p);
      else if (entry.isFile()) size += statSync(p).size;
    }
  } catch {}
  return size;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function orphanRefs(ledger: Ledger): WorktreeRef[] {
  const refs = [...(ledger.meta.worktrees ?? []), ...(ledger.meta.removedWorktrees ?? [])];
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (!validWorktreeRef(ref)) return true;
    const key = `${ref.repo}\0${ref.branch}\0${ref.base}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validWorktreeRef(value: unknown): value is WorktreeRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Partial<WorktreeRef>;
  return [ref.repo, ref.path, ref.branch, ref.base].every((field) => typeof field === "string");
}

function inspectOrphan(ledger: Ledger, policy: Policy): { ok: boolean; reason?: string } {
  const refs = orphanRefs(ledger);
  if (refs.length === 0) {
    return {
      ok: false,
      reason: "R8: no recorded branch refs; keep the ledger because merged/pushed state cannot be verified",
    };
  }
  for (const ref of refs) {
    if (!validWorktreeRef(ref)) {
      return { ok: false, reason: "R8: invalid branch metadata; repair the ledger before pruning" };
    }
    if (!existsSync(ref.repo)) {
      return { ok: false, reason: `R8: repo is unavailable (${ref.repo}); restore access before pruning` };
    }
    if (!isGitRepo(ref.repo)) {
      return { ok: false, reason: `R8: cannot verify Git history in ${ref.repo}; repair the repo before pruning` };
    }
    const policyBase = projectFor(policy, ref.repo).baseBranch;
    if (!branchPreservation(ref, policyBase)) {
      return {
        ok: false,
        reason: `R8: branch ${ref.branch} is neither merged into ${ref.base} nor fully pushed; merge/push it first`,
      };
    }
  }
  return { ok: true };
}

function taskLogs(taskId: string): string[] {
  if (!existsSync(P.logDir)) return [];
  return readdirSync(P.logDir)
    .filter((file) => file.startsWith(`${taskId}__`))
    .map((file) => join(P.logDir, file));
}

function taskArtifactSize(ledger: Ledger): number {
  const taskId = basename(ledger.path, ".md");
  const paths = [ledger.path, ...taskLogs(taskId)];
  const sessions = piSessionDir(taskId);
  const sessionBytes = existsSync(sessions) && !lstatSync(sessions).isSymbolicLink()
    ? dirSize(sessions) : 0;
  return sessionBytes + paths.reduce((total, path) => total + (existsSync(path) ? statSync(path).size : 0), 0);
}

function purgeLedgerAndLogs(ledger: Ledger): void {
  const taskId = basename(ledger.path, ".md");
  rmSync(piSessionDir(taskId), { recursive: true, force: true });
  for (const log of taskLogs(taskId)) rmSync(log, { force: true });
  // The ledger is the audit trail, so remove it last.
  rmSync(ledger.path, { force: true });
}

function pruneOrphanAdmin(ledger: Ledger): void {
  for (const repo of new Set(orphanRefs(ledger).filter(validWorktreeRef).map((ref) => ref.repo))) {
    git(repo, ["worktree", "prune"]);
  }
}

void BACKENDS;
