import { after, afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  acquireLock,
  cleanupTaskWorktrees,
  releaseLock,
} from "./dist/worktree.js";
import { main } from "./dist/cli.js";
import { P, piSessionDir } from "./dist/paths.js";
import { createLedger, readLedger, writeLedger } from "./dist/ledger.js";
import { savePolicy } from "./dist/policy.js";
import type { Ledger, Policy, WorktreeRef } from "./dist/types.js";

const POLICY: Policy = {
  defaults: { commands: [], denyCommands: [], write: true, network: true, applicationStack: {} },
  routing: { manage: [], implement: [], review: [], chore: [] },
  cooldown: { defaultMinutes: 1, failureMinutes: 1 },
  models: {},
  projects: {},
  notify: { on: [] },
  cleanup: {
    onDone: true,
    keepBranch: true,
    keepLedger: true,
    salvage: [".env*", "*.pem", "*.key", "credentials*"],
    salvageExclude: [".venv", "venv", "node_modules", "site-packages", "__pycache__", "dist", "build", ".next", ".git"],
  },
  vibemin: { required: false, maxAttempts: 1, timeout: 1 },
};

const originalPaths = { ...P };
let tmpRoot = "";

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(name: string): string {
  const repo = join(tmpRoot, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Fleet Test"]);
  git(repo, ["config", "user.email", "fleet-test@example.invalid"]);
  git(repo, ["commit", "--allow-empty", "-m", "initial"]);
  return repo;
}

function addWorktree(repo: string, branch: string, path?: string): WorktreeRef {
  const worktree = path ?? join(P.worktreeDir, `${basename(repo)}-${branch}`);
  mkdirSync(join(worktree, ".."), { recursive: true });
  git(repo, ["worktree", "add", "-b", branch, worktree, "main"]);
  return { repo, path: worktree, branch, base: "main" };
}

function ledger(taskId: string, refs: WorktreeRef[], status: Ledger["meta"]["status"] = "done"): Ledger {
  const value = createLedger({ id: taskId, repo: refs[0]?.repo ?? tmpRoot });
  value.meta.status = status;
  value.meta.worktrees = refs;
  writeLedger(value);
  return readLedger(taskId)!;
}

function policyWithCleanup(cleanup: Partial<Policy["cleanup"]>): Policy {
  return { ...POLICY, cleanup: { ...POLICY.cleanup, ...cleanup } };
}

function branchExists(repo: string, branch: string): boolean {
  try {
    git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await main(args), stdout, stderr };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "fleet-cleanup-test-"));
  const home = join(tmpRoot, "fleet-home");
  Object.assign(P, {
    home,
    policy: join(home, "policy.yaml"),
    events: join(home, "events.jsonl"),
    health: join(home, "state", "health.json"),
    managed: join(home, "state", "managed.json"),
    mute: join(home, "state", "mute.json"),
    ledgerDir: join(home, "ledger"),
    logDir: join(home, "logs"),
    stateDir: join(home, "state"),
    backupDir: join(home, "backups"),
    worktreeDir: join(home, "worktrees"),
  });
  for (const directory of [P.home, P.ledgerDir, P.logDir, P.stateDir, P.backupDir, P.worktreeDir]) {
    mkdirSync(directory, { recursive: true });
  }
  savePolicy(POLICY);
});

afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));
after(() => Object.assign(P, originalPaths));

describe("cleanup safety rails", { concurrency: 1 }, () => {
  test("R1 refuses non-ignored untracked files", () => {
    const repo = initRepo("dirty-repo");
    const ref = addWorktree(repo, "dirty-branch");
    ledger("dirty-task", [ref]);
    writeFileSync(join(ref.path, "untracked.txt"), "work");

    const result = cleanupTaskWorktrees(POLICY, "dirty-task", false);

    assert.equal(result.ok, false);
    assert.match(result.reason!, /^R1:/);
    assert.equal(existsSync(ref.path), true);
  });

  test("R1 treats ignored files as clean, salvages .env, and removes with force", () => {
    const repo = initRepo("ignored-repo");
    writeFileSync(join(repo, ".gitignore"), ".env*\n.venv/\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["commit", "-m", "ignore local state"]);
    const ref = addWorktree(repo, "ignored-branch");
    ledger("ignored-task", [ref]);
    writeFileSync(join(ref.path, ".env"), "TOKEN=only-copy");
    mkdirSync(join(ref.path, ".venv"));
    writeFileSync(join(ref.path, ".venv", "cache"), "large ignored cache");

    const result = cleanupTaskWorktrees(POLICY, "ignored-task", false);

    assert.equal(result.ok, true, result.reason);
    assert.equal(existsSync(ref.path), false);
    assert.equal(readFileSync(join(P.home, "salvage", "ignored-task", ".env"), "utf8"), "TOKEN=only-copy");
    assert.equal(existsSync(join(P.home, "salvage", "ignored-task", ".venv")), false);
  });

  test("R2 refuses in_progress unless forced", () => {
    const repo = initRepo("progress-repo");
    const ref = addWorktree(repo, "progress-branch");
    ledger("progress-task", [ref], "in_progress");

    const refused = cleanupTaskWorktrees(POLICY, "progress-task", false);
    assert.equal(refused.ok, false);
    assert.match(refused.reason!, /^R2:/);
    assert.equal(existsSync(ref.path), true);

    const forced = cleanupTaskWorktrees(POLICY, "progress-task", true);
    assert.equal(forced.ok, true, forced.reason);
    assert.equal(existsSync(ref.path), false);
  });

  test("R3 refuses a live run lock even with --force", () => {
    const repo = initRepo("locked-repo");
    const ref = addWorktree(repo, "locked-branch");
    ledger("locked-task", [ref]);
    assert.equal(
      acquireLock(ref.path, {
        backend: "codex",
        runId: "live-run",
        taskId: "locked-task",
        pid: process.pid,
      }),
      null,
    );

    try {
      const result = cleanupTaskWorktrees(POLICY, "locked-task", true);
      assert.equal(result.ok, false);
      assert.match(result.reason!, /^R3:/);
      assert.equal(existsSync(ref.path), true);
    } finally {
      releaseLock(ref.path);
    }
  });

  test("R4 keeps an unmerged, unpushed branch when branch cleanup is enabled", () => {
    const repo = initRepo("unmerged-repo");
    const ref = addWorktree(repo, "unmerged-branch");
    writeFileSync(join(ref.path, "commit.txt"), "only local copy");
    git(ref.path, ["add", "commit.txt"]);
    git(ref.path, ["commit", "-m", "unmerged work"]);
    ledger("unmerged-task", [ref]);

    const result = cleanupTaskWorktrees(policyWithCleanup({ keepBranch: false }), "unmerged-task", false);

    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(result.keptBranches, ["unmerged-branch"]);
    assert.equal(branchExists(repo, "unmerged-branch"), true);
  });

  test("R4 keeps a branch whose origin ref is behind its local tip", () => {
    const remote = join(tmpRoot, "remote.git");
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    const repo = initRepo("partly-pushed-repo");
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-u", "origin", "main"]);
    const ref = addWorktree(repo, "partly-pushed");
    writeFileSync(join(ref.path, "first.txt"), "pushed");
    git(ref.path, ["add", "first.txt"]);
    git(ref.path, ["commit", "-m", "pushed commit"]);
    git(ref.path, ["push", "-u", "origin", "partly-pushed"]);
    writeFileSync(join(ref.path, "second.txt"), "not pushed");
    git(ref.path, ["add", "second.txt"]);
    git(ref.path, ["commit", "-m", "local-only commit"]);
    ledger("partly-pushed-task", [ref]);

    const result = cleanupTaskWorktrees(
      policyWithCleanup({ keepBranch: false }),
      "partly-pushed-task",
      false,
    );

    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(result.keptBranches, ["partly-pushed"]);
    assert.equal(branchExists(repo, "partly-pushed"), true);
  });

  test("R4 may delete a fully pushed branch when keepBranch is false", () => {
    const remote = join(tmpRoot, "safe-remote.git");
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    const repo = initRepo("pushed-repo");
    git(repo, ["remote", "add", "origin", remote]);
    const ref = addWorktree(repo, "pushed-branch");
    writeFileSync(join(ref.path, "pushed.txt"), "remote copy");
    git(ref.path, ["add", "pushed.txt"]);
    git(ref.path, ["commit", "-m", "pushed work"]);
    git(ref.path, ["push", "-u", "origin", "pushed-branch"]);
    ledger("pushed-task", [ref]);

    const result = cleanupTaskWorktrees(policyWithCleanup({ keepBranch: false }), "pushed-task", false);

    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(result.keptBranches, []);
    assert.equal(branchExists(repo, "pushed-branch"), false);
  });

  test("R5 escapes glob metacharacters and .env* includes .env itself", () => {
    const repo = initRepo("salvage-repo");
    writeFileSync(join(repo, ".gitignore"), ".env*\n*.pem\n*.key\ncredentials*\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["commit", "-m", "ignore secrets"]);
    const ref = addWorktree(repo, "salvage-branch");
    ledger("salvage-task", [ref]);
    mkdirSync(join(ref.path, "nested"));
    const secrets = new Map([
      [".env", "base"],
      [".env.local", "local"],
      ["tls+.pem", "pem"],
      ["nested/name[1].key", "key"],
      ["nested/credentials.json", "credentials"],
    ]);
    for (const [path, contents] of secrets) writeFileSync(join(ref.path, path), contents);

    const result = cleanupTaskWorktrees(POLICY, "salvage-task", false);

    assert.equal(result.ok, true, result.reason);
    assert.equal(result.salvaged?.length, secrets.size);
    for (const [path, contents] of secrets) {
      assert.equal(readFileSync(join(P.home, "salvage", "salvage-task", path), "utf8"), contents);
    }
  });

  test("R5 excludes vendored directories from salvage", () => {
    const repo = initRepo("exclude-repo");
    writeFileSync(join(repo, ".gitignore"), ".env\n.venv/\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["commit", "-m", "ignore"]);
    const ref = addWorktree(repo, "exclude-branch");
    ledger("exclude-task", [ref]);
    mkdirSync(join(ref.path, ".venv", "lib"), { recursive: true });
    writeFileSync(join(ref.path, ".venv", "lib", "test.pem"), "junk");
    writeFileSync(join(ref.path, ".env"), "keep");
    
    const result = cleanupTaskWorktrees(POLICY, "exclude-task", false);
    
    assert.equal(result.ok, true, result.reason);
    assert.equal(existsSync(join(P.home, "salvage", "exclude-task", ".env")), true);
    assert.equal(existsSync(join(P.home, "salvage", "exclude-task", ".venv")), false);
  });

  test("R5 salvage failure aborts before any repository is removed", () => {
    const taskId = "salvage-failure-task";
    const parent = join(P.worktreeDir, taskId);
    const refs = ["one", "two"].map((name) => {
      const repo = initRepo(`salvage-${name}`);
      writeFileSync(join(repo, ".gitignore"), ".env\n");
      git(repo, ["add", ".gitignore"]);
      git(repo, ["commit", "-m", "ignore env"]);
      const ref = addWorktree(repo, `${name}-branch`, join(parent, name));
      writeFileSync(join(ref.path, ".env"), name);
      return ref;
    });
    ledger(taskId, refs);
    mkdirSync(join(P.home, "salvage"), { recursive: true });
    writeFileSync(join(P.home, "salvage", taskId), "blocks destination directory");

    const result = cleanupTaskWorktrees(POLICY, taskId, false);

    assert.equal(result.ok, false);
    assert.match(result.reason!, /^R5:/);
    assert.equal(existsSync(refs[0]!.path), true);
    assert.equal(existsSync(refs[1]!.path), true);
    assert.equal(readLedger(taskId)!.meta.worktrees?.length, 2);
  });

  test("R6 evaluates all repositories before removing any", () => {
    const taskId = "atomic-task";
    const parent = join(P.worktreeDir, taskId);
    const refs = ["one", "two", "three"].map((name) => {
      const repo = initRepo(`atomic-${name}`);
      return addWorktree(repo, `${name}-branch`, join(parent, name));
    });
    ledger(taskId, refs);
    writeFileSync(join(refs[1]!.path, "dirty.txt"), "repo two is ineligible");

    const result = cleanupTaskWorktrees(POLICY, taskId, false);

    assert.equal(result.ok, false);
    assert.match(result.reason!, /^R1:/);
    for (const ref of refs) assert.equal(existsSync(ref.path), true);
    assert.equal(readLedger(taskId)!.meta.worktrees?.length, 3);
  });

  test("R7 removes an empty task parent but never the shared worktree root", () => {
    const taskId = "parent-task";
    const parent = join(P.worktreeDir, taskId);
    const refs = ["one", "two"].map((name) => {
      const repo = initRepo(`parent-${name}`);
      return addWorktree(repo, `${name}-branch`, join(parent, name));
    });
    ledger(taskId, refs);

    const result = cleanupTaskWorktrees(POLICY, taskId, false);

    assert.equal(result.ok, true, result.reason);
    assert.equal(existsSync(parent), false);
    assert.equal(existsSync(P.worktreeDir), true);
  });

  test("R7 never deletes WORKPLAN.md or its parent", () => {
    const taskId = "workplan-task";
    const parent = join(P.worktreeDir, taskId);
    const refs = ["one", "two"].map((name) => {
      const repo = initRepo(`workplan-${name}`);
      return addWorktree(repo, `${name}-branch`, join(parent, name));
    });
    const workplan = join(parent, "WORKPLAN.md");
    writeFileSync(workplan, "keep this audit plan");
    ledger(taskId, refs);

    const result = cleanupTaskWorktrees(POLICY, taskId, false);

    assert.equal(result.ok, true, result.reason);
    assert.equal(readFileSync(workplan, "utf8"), "keep this audit plan");
    assert.equal(existsSync(parent), true);
  });
});

describe("prune integration", { concurrency: 1 }, () => {
  test("task done runs the safe cleanup path automatically", async () => {
    const repo = initRepo("auto-done-repo");
    const ref = addWorktree(repo, "auto-done-branch");
    ledger("auto-done-task", [ref], "in_progress");

    const result = await runCli(["task", "done", "auto-done-task"]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /auto-cleaned worktrees/);
    assert.equal(existsSync(ref.path), false);
    const current = readLedger("auto-done-task")!;
    assert.equal(current.meta.status, "done");
    assert.equal(current.meta.worktrees?.length, 0);
    assert.equal(current.meta.removedWorktrees?.[0]?.branch, ref.branch);
  });

  test("dry-run reports eligibility and salvage destinations without changing anything", async () => {
    const repo = initRepo("dry-run-repo");
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["commit", "-m", "ignore env"]);
    const ref = addWorktree(repo, "dry-run-branch");
    const value = ledger("dry-run-task", [ref]);
    writeFileSync(join(ref.path, ".env"), "DO_NOT_MOVE=1");
    const log = join(P.logDir, "dry-run-task__run.jsonl");
    writeFileSync(log, "log stays");
    const ledgerBefore = readFileSync(value.path, "utf8");
    const worktreesBefore = git(repo, ["worktree", "list", "--porcelain"]);

    const result = await runCli(["prune", "--dry-run"]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /eligible.*would remove 1 worktree/);
    assert.match(result.stdout, /would salvage.*\.env.* -> /);
    assert.match(result.stdout, /Dry run:.*no files changed/);
    assert.equal(readFileSync(value.path, "utf8"), ledgerBefore);
    assert.equal(readFileSync(join(ref.path, ".env"), "utf8"), "DO_NOT_MOVE=1");
    assert.equal(readFileSync(log, "utf8"), "log stays");
    assert.equal(git(repo, ["worktree", "list", "--porcelain"]), worktreesBefore);
    assert.equal(existsSync(join(P.home, "salvage", "dry-run-task")), false);
  });

  test("R8 keeps an orphaned ledger and logs for an unmerged, unpushed branch", async () => {
    const repo = initRepo("orphan-unsafe-repo");
    const ref = addWorktree(repo, "orphan-unsafe-branch");
    writeFileSync(join(ref.path, "only-copy.txt"), "unmerged commit");
    git(ref.path, ["add", "only-copy.txt"]);
    git(ref.path, ["commit", "-m", "only local"]);
    const value = ledger("orphan-unsafe-task", [ref]);
    const log = join(P.logDir, "orphan-unsafe-task__run.jsonl");
    writeFileSync(log, "audit log");
    const sessions = piSessionDir(value.meta.id);
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "run.jsonl"), "session audit");
    git(repo, ["worktree", "remove", "--force", ref.path]);

    const result = await runCli(["prune"]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /R8: branch orphan-unsafe-branch is neither merged/);
    assert.equal(existsSync(value.path), true);
    assert.equal(existsSync(log), true);
    assert.equal(existsSync(sessions), true);
    assert.equal(branchExists(repo, ref.branch), true);
  });

  test("R8 purges orphaned ledger and logs only after branch preservation is verified", async () => {
    const repo = initRepo("orphan-safe-repo");
    const ref = addWorktree(repo, "orphan-safe-branch");
    const value = ledger("orphan-safe-task", [ref]);
    const log = join(P.logDir, "orphan-safe-task__run.jsonl");
    writeFileSync(log, "audit log");
    const sessions = piSessionDir(value.meta.id);
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "run.jsonl"), "session audit");
    const unrelated = piSessionDir("different-task");
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(unrelated, "keep.jsonl"), "other task");
    value.meta.id = "different-task";
    writeLedger(value);
    git(repo, ["worktree", "remove", "--force", ref.path]);

    const result = await runCli(["prune"]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /purged.*ledger\/logs/);
    assert.equal(existsSync(value.path), false);
    assert.equal(existsSync(log), false);
    assert.equal(existsSync(sessions), false);
    assert.equal(existsSync(unrelated), true);
  });

  test("R8 uses the recorded branch tip after safe branch deletion", async () => {
    const remote = join(tmpRoot, "r8-remote.git");
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    const repo = initRepo("r8-recorded-repo");
    git(repo, ["remote", "add", "origin", remote]);
    const ref = addWorktree(repo, "r8-recorded-branch");
    writeFileSync(join(ref.path, "pushed.txt"), "preserved remotely");
    git(ref.path, ["add", "pushed.txt"]);
    git(ref.path, ["commit", "-m", "preserved work"]);
    git(ref.path, ["push", "-u", "origin", ref.branch]);
    const value = ledger("r8-recorded-task", [ref]);
    const cleanup = cleanupTaskWorktrees(
      policyWithCleanup({ keepBranch: false }),
      "r8-recorded-task",
      false,
    );
    assert.equal(cleanup.ok, true, cleanup.reason);
    assert.equal(branchExists(repo, ref.branch), false);
    assert.match(readLedger("r8-recorded-task")!.meta.removedWorktrees?.[0]?.head ?? "", /^[0-9a-f]{40}$/);

    const result = await runCli(["prune"]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(value.path), false);
  });

  test("R8 allows a remote-only branch when the ledger has no recorded head", async () => {
    const remote = join(tmpRoot, "r8-remote-only.git");
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    const repo = initRepo("r8-remote-only-repo");
    git(repo, ["remote", "add", "origin", remote]);
    const ref = addWorktree(repo, "r8-remote-only-branch");
    writeFileSync(join(ref.path, "remote-only.txt"), "preserved remotely");
    git(ref.path, ["add", "remote-only.txt"]);
    git(ref.path, ["commit", "-m", "remote-only work"]);
    git(ref.path, ["push", "-u", "origin", ref.branch]);
    const value = ledger("r8-remote-only-task", [ref]);
    git(repo, ["worktree", "remove", "--force", ref.path]);
    git(repo, ["branch", "-D", ref.branch]);

    const result = await runCli(["prune", "--dry-run"]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /r8-remote-only-task\s+.*eligible/);
    assert.doesNotMatch(result.stdout, /r8-remote-only-task\s+.*nor fully pushed/);
    assert.equal(existsSync(value.path), true);
  });

  test("R8 allows missing branch, refuses unmerged using policy base", async () => {
    const repo = initRepo("policy-base-repo");
    const customPolicy = { ...POLICY, projects: { [repo]: { baseBranch: "main" } } };
    savePolicy(customPolicy);
    
    const ref1 = addWorktree(repo, "unmerged-branch");
    writeFileSync(join(ref1.path, "work.txt"), "local");
    git(ref1.path, ["add", "work.txt"]);
    git(ref1.path, ["commit", "-m", "unmerged"]);
    const l1 = ledger("unmerged-task", [{ ...ref1, base: "wrong-base" }]);
    git(repo, ["worktree", "remove", "--force", ref1.path]);

    const ref2 = addWorktree(repo, "missing-branch");
    const l2 = ledger("missing-task", [{ ...ref2, base: "main" }]);
    git(repo, ["worktree", "remove", "--force", ref2.path]);
    git(repo, ["branch", "-D", "missing-branch"]);

    const result = await runCli(["prune"]);
    
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /R8: branch unmerged-branch is neither merged into wrong-base nor fully pushed/);
    assert.equal(existsSync(l1.path), true);
    assert.equal(existsSync(l2.path), false);
  });

  test("--status complete matches complete ledgers and not done ledgers", async () => {
    const completeRepo = initRepo("complete-repo");
    const completeRef = addWorktree(completeRepo, "complete-branch");
    ledger("complete-task", [completeRef], "complete");
    git(completeRepo, ["worktree", "remove", "--force", completeRef.path]);
    const doneRepo = initRepo("done-repo");
    const doneRef = addWorktree(doneRepo, "done-branch");
    ledger("done-task", [doneRef], "done");
    git(doneRepo, ["worktree", "remove", "--force", doneRef.path]);

    const result = await runCli(["prune", "--dry-run", "--status", "complete"]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /complete-task\s+.*eligible/);
    assert.match(result.stdout, /done-task\s+.*filtered.*status is done/);
  });
});
