import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  statSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { P } from "./paths.js";
import { projectFor } from "./policy.js";
import type { Policy, PolicyProject, WorktreeRef, BackendId } from "./types.js";
import { readLedger, writeLedger } from "./ledger.js";

export function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitQuiet(repo: string, args: string[]): string | null {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
}

export function isGitRepo(dir: string): boolean {
  return gitQuiet(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

/** The repository root for a path inside a repo or worktree. */
export function repoRoot(dir: string): string | null {
  return gitQuiet(dir, ["rev-parse", "--show-toplevel"]);
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Detect the default base branch: explicit config > origin/HEAD > develop > main. */
export function detectBaseBranch(repo: string, cfg: PolicyProject): string {
  if (cfg.baseBranch) return cfg.baseBranch;
  const head = gitQuiet(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^origin\//, "");
  for (const candidate of ["develop", "main", "master"]) {
    if (gitQuiet(repo, ["rev-parse", "--verify", `refs/remotes/origin/${candidate}`])) {
      return candidate;
    }
  }
  return gitQuiet(repo, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "main";
}

export interface BranchSpec {
  kind?: string;
  ticket?: string;
  slug: string;
}

/**
 * Render a branch name from the project's convention.
 * `{ticket}` collapses without leaving a stray separator when absent.
 */
export function renderBranch(cfg: PolicyProject, spec: BranchSpec): string {
  const pattern = cfg.branchPattern ?? "{kind}/{ticket}-{slug}";
  const kind = spec.kind ?? cfg.defaultKind ?? "task";
  const out = pattern
    .replace(/\{kind\}/g, kind)
    .replace(/\{ticket\}/g, spec.ticket ?? "")
    .replace(/\{slug\}/g, spec.slug);
  // Collapse the separator left behind by an empty {ticket}.
  return out
    .replace(/\/-+/g, "/")
    .replace(/-{2,}/g, "-")
    .replace(/-+$/g, "")
    .replace(/\/+$/g, "");
}

/** Resolve which repos a task spans for a given project key. */
export function reposForProject(projectKey: string, cfg: PolicyProject): string[] {
  if (cfg.repos?.length) {
    return cfg.repos.map((r) => (isAbsolute(r) ? r : resolve(projectKey, r)));
  }
  return [projectKey];
}

export function worktreePathFor(
  cfg: PolicyProject,
  repo: string,
  taskId: string,
  slug: string,
): string {
  const repoName = basename(repo);
  const template = cfg.worktreeRoot ?? join(P.worktreeDir, "{repoName}-{taskId}");
  return template
    .replace(/\{repoName\}/g, repoName)
    .replace(/\{taskId\}/g, taskId)
    .replace(/\{slug\}/g, slug);
}

export interface EnsureOpts {
  policy: Policy;
  projectKey: string;
  taskId: string;
  spec: BranchSpec;
  repos?: string[];
  /**
   * Branch from this ref instead of the project's default base. Needed when
   * the work depends on commits that have not reached the default branch
   * yet: without it the agent silently gets a worktree missing them, and
   * writes code against a state that no longer exists.
   */
  base?: string;
}

/**
 * Create (or reuse) one worktree per repo the task spans. Idempotent: an
 * existing worktree on the right branch is reused rather than recreated.
 */
export function ensureWorktrees(opts: EnsureOpts): WorktreeRef[] {
  const cfg = projectFor(opts.policy, opts.projectKey);
  const repos = opts.repos ?? reposForProject(opts.projectKey, cfg);
  const out: WorktreeRef[] = [];

  for (const repo of repos) {
    if (!isGitRepo(repo)) {
      throw new Error(`Not a git repository: ${repo}`);
    }
    const root = repoRoot(repo) ?? repo;
    if (cfg.requireTicket && !opts.spec.ticket) {
      throw new Error(
        `Project ${opts.projectKey} requires a ticket number (convention: ${
          cfg.branchPattern ?? "{kind}/{ticket}-{slug}"
        }). Pass --ticket.`,
      );
    }
    const branch = renderBranch(cfg, opts.spec);
    const base = opts.base ?? detectBaseBranch(root, cfg);
    if (opts.base && gitQuiet(root, ["rev-parse", "--verify", opts.base]) === null) {
      throw new Error(`Base ref not found in ${root}: ${opts.base}`);
    }
    const path = worktreePathFor(cfg, root, opts.taskId, opts.spec.slug);

    const existing = listWorktrees(root).find((w) => w.path === path || w.branch === branch);
    if (existing) {
      out.push({ repo: root, path: existing.path, branch: existing.branch, base });
      continue;
    }

    mkdirSync(join(path, ".."), { recursive: true });

    const branchExists =
      gitQuiet(root, ["rev-parse", "--verify", `refs/heads/${branch}`]) !== null;
    const startPoint =
      gitQuiet(root, ["rev-parse", "--verify", `refs/remotes/origin/${base}`]) !== null
        ? `origin/${base}`
        : base;

    if (branchExists) {
      git(root, ["worktree", "add", path, branch]);
    } else {
      git(root, ["worktree", "add", "-b", branch, path, startPoint]);
    }
    out.push({ repo: root, path, branch, base });
  }
  return out;
}

/**
 * How far the repo's checked-out branch is ahead of the base a worktree was
 * cut from, or null when it is not ahead. Used to warn that a new worktree
 * is missing local work.
 */
export function commitsAhead(repo: string, base: string): { branch: string; count: number } | null {
  const branch = gitQuiet(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD" || branch === base) return null;
  const raw = gitQuiet(repo, ["rev-list", "--count", `${base}..${branch}`]);
  const count = raw ? Number(raw) : 0;
  return count > 0 ? { branch, count } : null;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
}

export function listWorktrees(repo: string): WorktreeInfo[] {
  const raw = gitQuiet(repo, ["worktree", "list", "--porcelain"]);
  if (!raw) return [];
  const out: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? "", head: cur.head ?? "" });
      cur = { path: line.slice(9) };
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice(7).replace("refs/heads/", "");
    }
  }
  if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? "", head: cur.head ?? "" });
  return out;
}

export function removeWorktree(repo: string, path: string, force: boolean): void {
  git(repo, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
}

/** Uncommitted changes in a worktree, as porcelain lines. */
export function dirtyFiles(worktree: string): string[] {
  const raw = gitQuiet(worktree, ["status", "--porcelain"]);
  return raw ? raw.split("\n").filter(Boolean) : [];
}

export function isBranchMerged(repo: string, branch: string, base: string): boolean {
  return gitQuiet(repo, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, base]) !== null;
}

export function localBranchExists(repo: string, branch: string): boolean {
  return gitQuiet(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]) !== null;
}

/** True only when every local commit on the branch is reachable from origin. */
export function branchExistsOnOrigin(repo: string, branch: string): boolean {
  const local = gitQuiet(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (!local || !remoteBranchExists(repo, branch)) {
    return false;
  }
  return gitQuiet(repo, [
    "merge-base",
    "--is-ancestor",
    local,
    `refs/remotes/origin/${branch}`,
  ]) !== null;
}

export function remoteBranchExists(repo: string, branch: string): boolean {
  return gitQuiet(repo, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`]) !== null;
}

export function branchPreservation(ref: WorktreeRef, policyBase?: string): "merged" | "pushed" | "missing" | null {
  const localCommit = gitQuiet(ref.repo, ["rev-parse", "--verify", `refs/heads/${ref.branch}`]);
  if (!localCommit) {
    return remoteBranchExists(ref.repo, ref.branch) ? "pushed" : "missing";
  }
  const commit = localCommit;

  if (gitQuiet(ref.repo, ["merge-base", "--is-ancestor", commit, ref.base]) !== null) {
    return "merged";
  }
  if (policyBase && gitQuiet(ref.repo, ["merge-base", "--is-ancestor", commit, policyBase]) !== null) {
    return "merged";
  }

  if (
    remoteBranchExists(ref.repo, ref.branch) &&
    gitQuiet(ref.repo, [
      "merge-base",
      "--is-ancestor",
      commit,
      `refs/remotes/origin/${ref.branch}`,
    ]) !== null
  ) {
    return "pushed";
  }
  return null;
}

export function isBranchPreservedElsewhere(ref: WorktreeRef, policyBase?: string): boolean {
  return branchPreservation(ref, policyBase) !== null;
}

export interface SalvageFile {
  source: string;
  destination: string;
  relativePath: string;
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (const char of pattern) {
    source += char === "*" ? ".*" : char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe === "" || safe === "." || safe === ".." ? "_" : safe;
}

export function planSalvage(
  worktree: string,
  taskId: string,
  salvagePatterns: string[],
  salvageExclude: string[],
  namespace = "",
): SalvageFile[] {
  if (salvagePatterns.length === 0) return [];
  const regexes = salvagePatterns.map(globRegex);
  const taskDir = join(P.home, "salvage", safeSegment(taskId));
  const salvageDir = namespace ? join(taskDir, safeSegment(namespace)) : taskDir;
  const planned: SalvageFile[] = [];
  const directories = [worktree];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!salvageExclude.includes(entry.name)) {
          directories.push(source);
        }
        continue;
      }
      if ((!entry.isFile() && !entry.isSymbolicLink()) || !regexes.some((r) => r.test(entry.name))) {
        continue;
      }
      const relativePath = relative(worktree, source);
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
        throw new Error(`salvage path escaped worktree: ${source}`);
      }
      planned.push({ source, destination: join(salvageDir, relativePath), relativePath });
    }
  }
  return planned;
}

function filesMatch(a: string, b: string): boolean {
  const left = readFileSync(a);
  const right = readFileSync(b);
  return left.length === right.length && left.equals(right);
}

export function performSalvage(planned: SalvageFile[]): SalvageFile[] {
  for (const file of planned) {
    const relativeDestination = relative(join(P.home, "salvage"), file.destination);
    const taskDir = join(P.home, "salvage", relativeDestination.split("/")[0]!);
    mkdirSync(dirname(file.destination), { recursive: true, mode: 0o700 });
    if (existsSync(taskDir)) chmodSync(taskDir, 0o700);
    if (existsSync(file.destination)) {
      if (!filesMatch(file.source, file.destination)) {
        throw new Error(`salvage destination already exists with different contents: ${file.destination}`);
      }
      continue;
    }
    copyFileSync(file.source, file.destination, constants.COPYFILE_EXCL);
    chmodSync(file.destination, statSync(file.source).mode & 0o777);
    if (!filesMatch(file.source, file.destination)) {
      throw new Error(`salvage verification failed: ${file.destination}`);
    }
  }
  return planned;
}

export interface CleanupResult {
  ok: boolean;
  reason?: string;
  salvaged?: SalvageFile[];
  keptBranch?: boolean;
  keptBranches?: string[];
  removedWorktrees?: string[];
}

export interface CleanupInspection extends CleanupResult {
  worktrees: WorktreeRef[];
  salvage: SalvageFile[];
}

function salvageNamespaces(worktrees: WorktreeRef[]): Map<string, string> {
  const out = new Map<string, string>();
  if (worktrees.length === 1) {
    out.set(worktrees[0]!.path, "");
    return out;
  }
  const used = new Set<string>();
  for (const [index, worktree] of worktrees.entries()) {
    let namespace = safeSegment(basename(worktree.path));
    if (used.has(namespace)) namespace = `${safeSegment(basename(worktree.repo))}-${index + 1}`;
    used.add(namespace);
    out.set(worktree.path, namespace);
  }
  return out;
}

function liveLock(worktree: string): Lock | null {
  const path = lockPath(worktree);
  if (!existsSync(path)) return null;
  try {
    const held = JSON.parse(readFileSync(path, "utf8")) as Lock;
    return isAlive(held.pid) ? held : null;
  } catch {
    return null;
  }
}

export function inspectTaskCleanup(
  policy: Policy,
  taskId: string,
  force: boolean,
  ignoredLockPid?: number,
): CleanupInspection {
  const ledger = readLedger(taskId);
  if (!ledger) return { ok: false, reason: "No such task", worktrees: [], salvage: [] };
  const worktrees = ledger.meta.worktrees ?? [];
  if (worktrees.length === 0) {
    return { ok: false, reason: "No worktrees recorded", worktrees: [], salvage: [] };
  }

  if (!force && ledger.meta.status === "in_progress") {
    return {
      ok: false,
      reason: "R2: task is in_progress; mark it done or pass --force",
      worktrees,
      salvage: [],
    };
  }

  for (const worktree of worktrees as WorktreeRef[]) {
    if (
      !worktree ||
      typeof worktree.repo !== "string" ||
      typeof worktree.path !== "string" ||
      typeof worktree.branch !== "string" ||
      typeof worktree.base !== "string"
    ) {
      return {
        ok: false,
        reason: "R6: ledger contains an invalid worktree record; repair the ledger before retrying",
        worktrees,
        salvage: [],
      };
    }
  }

  const active = worktrees.filter((worktree) => existsSync(worktree.path));
  for (const w of worktrees) {
    if (!existsSync(w.path)) continue;
    let registered: WorktreeInfo | undefined;
    try {
      const expectedPath = realpathSync(w.path);
      registered = listWorktreesStrict(w.repo).find((candidate) => {
        try {
          return realpathSync(candidate.path) === expectedPath;
        } catch {
          return false;
        }
      });
    } catch (error) {
      return {
        ok: false,
        reason: `R6: cannot verify worktree registration in ${w.repo}: ${(error as Error).message}; repair the repo before retrying`,
        worktrees,
        salvage: [],
      };
    }
    if (!registered || registered.branch !== w.branch) {
      return {
        ok: false,
        reason: `R6: ${w.path} is not registered on expected branch ${w.branch}; repair the ledger or worktree before retrying`,
        worktrees,
        salvage: [],
      };
    }
    const held = liveLock(w.path);
    if (held && held.pid !== ignoredLockPid) {
      return {
        ok: false,
        reason: `R3: run ${held.runId} is live in ${w.path}; wait for it to finish`,
        worktrees,
        salvage: [],
      };
    }
    if (!force) {
      let dirty: string[];
      try {
        dirty = strictDirtyFiles(w.path);
      } catch (error) {
        return {
          ok: false,
          reason: `R1: cannot verify clean status in ${w.path}: ${(error as Error).message}; repair the worktree before retrying`,
          worktrees,
          salvage: [],
        };
      }
      if (dirty.length > 0) {
        return {
          ok: false,
          reason: `R1: worktree is dirty (${dirty.length} change(s) in ${basename(w.path)}); commit/stash them or pass --force`,
          worktrees,
          salvage: [],
        };
      }
    }
  }

  const namespaces = salvageNamespaces(active);
  const salvage: SalvageFile[] = [];
  try {
    for (const worktree of active) {
      salvage.push(
        ...planSalvage(
          worktree.path,
          taskId,
          policy.cleanup.salvage,
          policy.cleanup.salvageExclude ?? [],
          namespaces.get(worktree.path),
        ),
      );
    }
  } catch (error) {
    return {
      ok: false,
      reason: `R5: cannot inspect salvage files: ${(error as Error).message}; fix access before retrying`,
      worktrees,
      salvage: [],
    };
  }
  return { ok: true, worktrees, salvage };
}

export function cleanupTaskWorktrees(policy: Policy, taskId: string, force: boolean): CleanupResult {
  let inspection = inspectTaskCleanup(policy, taskId, force);
  if (!inspection.ok) return inspection;
  const active = inspection.worktrees.filter((worktree) => existsSync(worktree.path));
  const locked: WorktreeRef[] = [];
  try {
    for (const worktree of active) {
      const held = acquireLock(worktree.path, {
        backend: "fleet",
        runId: `cleanup-${taskId}`,
        taskId,
        pid: process.pid,
      });
      if (held) {
        return { ok: false, reason: `R3: run ${held.runId} is live in ${worktree.path}; wait for it to finish` };
      }
      locked.push(worktree);
    }
    inspection = inspectTaskCleanup(policy, taskId, force, process.pid);
    if (!inspection.ok) return inspection;
    try {
      performSalvage(inspection.salvage);
    } catch (error) {
      return {
        ok: false,
        reason: `R5: salvage failed: ${(error as Error).message}; no worktree was removed`,
      };
    }

    const auditedRefs = inspection.worktrees.map((worktree) => ({
      ...worktree,
      head: gitQuiet(worktree.repo, ["rev-parse", "--verify", `refs/heads/${worktree.branch}`]) ?? worktree.head,
    }));
    const auditedByPath = new Map(auditedRefs.map((worktree) => [worktree.path, worktree]));
    const removed: WorktreeRef[] = [];
    for (const worktree of active) {
      try {
        // R1 deliberately ignores ignored files; after salvage, --force is required
        // so .venv/.env do not turn a clean multi-repo cleanup into a partial one.
        removeWorktree(worktree.repo, worktree.path, true);
        removed.push(auditedByPath.get(worktree.path) ?? worktree);
        git(worktree.repo, ["worktree", "prune"]);
      } catch (error) {
        let ledgerFailure = "";
        try {
          persistRemovedWorktrees(taskId, removed);
        } catch (ledgerError) {
          ledgerFailure = `; ledger update also failed: ${(ledgerError as Error).message}`;
        }
        return {
          ok: false,
          reason: `R6: removal failed after ${removed.length}/${active.length} worktrees: ${(error as Error).message}; remaining repos were left untouched${ledgerFailure}`,
          removedWorktrees: removed.map((ref) => ref.path),
        };
      }
    }

    // Persist the exact refs and tips before optional branch deletion. If the
    // process stops later, R8 still has enough information to verify the work.
    try {
      persistRemovedWorktrees(taskId, auditedRefs);
    } catch (error) {
      return {
        ok: false,
        reason: `R6: worktrees were removed but the ledger update failed: ${(error as Error).message}; all branches were kept, fix the ledger and retry`,
        keptBranch: true,
        keptBranches: auditedRefs.map((ref) => ref.branch),
        removedWorktrees: removed.map((ref) => ref.path),
      };
    }

    const keptBranches: string[] = [];
    if (!policy.cleanup.keepBranch) {
      for (const worktree of auditedRefs) {
        if (!localBranchExists(worktree.repo, worktree.branch)) continue;
        const cfg = projectFor(policy, worktree.repo);
        if (!isBranchPreservedElsewhere(worktree, cfg.baseBranch)) {
          keptBranches.push(worktree.branch);
          continue;
        }
        try {
          git(worktree.repo, ["branch", "-D", worktree.branch]);
        } catch {
          keptBranches.push(worktree.branch);
        }
      }
    } else {
      keptBranches.push(
        ...auditedRefs
          .filter((worktree) => localBranchExists(worktree.repo, worktree.branch))
          .map((worktree) => worktree.branch),
      );
    }

    cleanupTaskParents(taskId, auditedRefs);

    return {
      ok: true,
      salvaged: inspection.salvage,
      keptBranch: keptBranches.length > 0,
      keptBranches,
      removedWorktrees: removed.map((ref) => ref.path),
    };
  } finally {
    for (const worktree of locked) releaseLock(worktree.path);
  }
}

function listWorktreesStrict(repo: string): WorktreeInfo[] {
  const raw = git(repo, ["worktree", "list", "--porcelain"]);
  if (!raw) return [];
  const out: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) out.push({ path: current.path, branch: current.branch ?? "", head: current.head ?? "" });
      current = { path: line.slice(9) };
    } else if (line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (line.startsWith("branch ")) current.branch = line.slice(7).replace("refs/heads/", "");
  }
  if (current.path) out.push({ path: current.path, branch: current.branch ?? "", head: current.head ?? "" });
  return out;
}

function strictDirtyFiles(worktree: string): string[] {
  const raw = git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return raw ? raw.split("\n").filter(Boolean) : [];
}

function persistRemovedWorktrees(taskId: string, removed: WorktreeRef[]): void {
  if (removed.length === 0) return;
  const ledger = readLedger(taskId);
  if (!ledger) return;
  const keys = new Set(removed.map((ref) => `${ref.repo}\0${ref.path}\0${ref.branch}`));
  ledger.meta.worktrees = (ledger.meta.worktrees ?? []).filter(
    (ref) => !keys.has(`${ref.repo}\0${ref.path}\0${ref.branch}`),
  );
  const prior = ledger.meta.removedWorktrees ?? [];
  const priorKeys = new Set(prior.map((ref) => `${ref.repo}\0${ref.path}\0${ref.branch}`));
  ledger.meta.removedWorktrees = [
    ...prior,
    ...removed.filter((ref) => !priorKeys.has(`${ref.repo}\0${ref.path}\0${ref.branch}`)),
  ];
  writeLedger(ledger);
}

function cleanupTaskParents(taskId: string, worktrees: WorktreeRef[]): void {
  for (const parent of new Set(worktrees.map((worktree) => dirname(worktree.path)))) {
    if (
      basename(parent) !== taskId ||
      basename(parent) === "agents" ||
      resolve(parent) === resolve(P.worktreeDir) ||
      !existsSync(parent) ||
      existsSync(join(parent, "WORKPLAN.md"))
    ) {
      continue;
    }
    try {
      if (readdirSync(parent).length === 0) rmdirSync(parent);
    } catch {
      // A concurrent file creation or a permissions error leaves the parent intact.
    }
  }
}

// ---------------------------------------------------------------------------
// Locking — one agent per worktree at a time.
// ---------------------------------------------------------------------------

interface Lock {
  backend: BackendId | "fleet";
  runId: string;
  taskId: string;
  pid: number;
  since: string;
}

function lockPath(worktree: string): string {
  // The slug truncates at 48 chars, so sibling worktrees sharing a long prefix used to
  // resolve to one lock file and silently refuse to run at the same time. The digest
  // keeps the name readable while making it unique to the full path.
  const digest = createHash("sha1").update(worktree).digest("hex").slice(0, 8);
  return join(P.stateDir, `lock-${slugify(worktree)}-${digest}.json`);
}

export function acquireLock(worktree: string, lock: Omit<Lock, "since">): Lock | null {
  const p = lockPath(worktree);
  if (existsSync(p)) {
    try {
      const held = JSON.parse(readFileSync(p, "utf8")) as Lock;
      if (isAlive(held.pid)) return held; // someone else owns it
    } catch {
      /* corrupt lock; take it */
    }
  }
  mkdirSync(P.stateDir, { recursive: true });
  writeFileSync(p, JSON.stringify({ ...lock, since: new Date().toISOString() }, null, 2));
  return null;
}

export function releaseLock(worktree: string): void {
  try {
    rmSync(lockPath(worktree), { force: true });
  } catch {
    /* best effort */
  }
}

export function isLocked(worktree: string): boolean {
  return liveLock(worktree) !== null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
