import { spawnSync } from "node:child_process";
import { appendHandoff } from "./ledger.js";
import { emit } from "./events.js";
import { vibeminFor } from "./policy.js";
import type { Ledger, Policy, WorktreeRef } from "./types.js";

export interface VibeminGateResult {
  ok: boolean;
  reason?: string;
  output?: string;
  worktree?: WorktreeRef;
}

function repeat(args: string[], flag: string, values?: string[]): void {
  for (const value of values ?? []) args.push(flag, value);
}

export function vibeminArgs(policy: Policy, ledger: Ledger, worktree: WorktreeRef): string[] {
  const config = vibeminFor(policy, ledger.meta.repo);
  if (!config.checks?.length) {
    throw new Error(
      `Vibemin is required but no checks are configured for ${worktree.repo}. ` +
      "Add projects.<path>.vibemin.checks in ~/.fleet/policy.yaml.",
    );
  }
  const args = ["--feature-base", worktree.base];
  repeat(args, "--check", config.checks);
  repeat(args, "--preserve-output", config.preserveOutput);
  repeat(args, "--final-check", config.finalChecks);
  repeat(args, "--security-check", config.securityChecks);
  repeat(args, "--test-strength-check", config.testStrengthChecks);
  repeat(args, "--dependency-check", config.dependencyChecks);
  if (config.allowTestChanges) args.push("--reduce-tests");
  if (config.allowDependencyChanges) args.push("--allow-dependency-changes");
  if (config.allowVisualChanges) args.push("--allow-visual-changes");
  if (config.allowUntypedTypescript) args.push("--allow-untyped-typescript");
  args.push("--max-attempts", String(config.maxAttempts));
  args.push("--timeout", String(config.timeout));
  return args;
}

export function runCompletionGate(policy: Policy, ledger: Ledger): VibeminGateResult {
  const config = vibeminFor(policy, ledger.meta.repo);
  if (!config.required) return { ok: true, output: "Vibemin disabled by project policy" };
  if (!ledger.meta.worktrees?.length) {
    return { ok: false, reason: "Vibemin cannot run: this task has no worktrees" };
  }
  for (const worktree of ledger.meta.worktrees) {
    let args: string[];
    try {
      args = vibeminArgs(policy, ledger, worktree);
    } catch (error) {
      return { ok: false, reason: (error as Error).message, worktree };
    }
    emit({
      runId: `vibemin-${ledger.meta.id}`,
      taskId: ledger.meta.id,
      backend: "fleet",
      type: "vibemin.start",
      msg: worktree.path,
    });
    const result = spawnSync("vibemin", args, {
      cwd: worktree.path,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.error || result.status !== 0) {
      const reason = result.error?.message ?? output.slice(-4_000) ?? `Vibemin exited ${result.status}`;
      emit({
        runId: `vibemin-${ledger.meta.id}`,
        taskId: ledger.meta.id,
        backend: "fleet",
        type: "vibemin.error",
        msg: reason,
      });
      appendHandoff(ledger.meta.id, `Vibemin completion gate FAILED in ${worktree.path}: ${reason}`);
      return { ok: false, reason, output, worktree };
    }
    emit({
      runId: `vibemin-${ledger.meta.id}`,
      taskId: ledger.meta.id,
      backend: "fleet",
      type: "vibemin.end",
      msg: output.slice(-1_000),
    });
    appendHandoff(ledger.meta.id, `Vibemin completion gate passed in ${worktree.path}: ${output}`);
  }
  return { ok: true, output: "Vibemin passed in every worktree" };
}
