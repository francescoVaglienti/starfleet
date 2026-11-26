export type BackendId = "claude" | "codex" | "copilot" | "antigravity" | "mimo" | "pi";

export const BACKEND_IDS: BackendId[] = ["claude", "codex", "copilot", "antigravity", "mimo", "pi"];

/** A role determines which backend chain is preferred. */
export type Role = "manage" | "implement" | "review" | "chore";

export const ROLES: Role[] = ["manage", "implement", "review", "chore"];

/**
 * Every event any backend emits is normalised into this shape and appended to
 * ~/.fleet/events.jsonl. This is the single audit log.
 */
export interface FleetEvent {
  ts: string;
  runId: string;
  taskId: string;
  backend: BackendId | "fleet";
  type: EventType;
  msg?: string;
  data?: unknown;
}

export type EventType =
  | "run.start"
  | "run.end"
  | "run.error"
  | "agent.text"
  | "agent.reasoning"
  | "tool.use"
  | "tool.result"
  | "permission.request"
  | "exhausted"
  | "failover"
  | "ledger.update"
  | "policy.sync"
  | "notify"
  | "vibemin.start"
  | "vibemin.end"
  | "vibemin.error";

export interface BackendHealth {
  state: "ok" | "cooldown" | "unavailable";
  reason?: string;
  /** ISO timestamp; while in the future the backend is skipped by the router. */
  cooldownUntil?: string;
  lastRunAt?: string;
  lastResolvedModel?: string;
  lastExitCode?: number | null;
  consecutiveFailures: number;
}

export type HealthFile = Partial<Record<BackendId, BackendHealth>>;

export interface RunOptions {
  taskId: string;
  runId: string;
  /** The fully-composed prompt, including the ledger preamble. */
  prompt: string;
  cwd: string;
  model?: string;
  effort?: string;
  /** Restrict the agent to read-only operation (used for review runs). */
  readOnly?: boolean;
  extraDirs?: string[];
}

export type ExhaustionKind = "rate_limit" | "quota" | "auth" | "unknown";

export interface Exhaustion {
  kind: ExhaustionKind;
  /** How long to cool this backend down for, in ms. */
  retryAfterMs: number;
  detail: string;
}

export interface Backend {
  id: BackendId;
  displayName: string;
  bin: string;
  /**
   * True when the backend streams assistant text as incremental chunks with no
   * terminating "message complete" event. The runner then reassembles the
   * chunks rather than treating the last one as the closing message.
   */
  streamsTextDeltas?: boolean;
  /** Resolved absolute path to the binary, or null when not installed. */
  resolveBin(): string | null;
  version?(): string | null;
  diagnosticLine?(line: string): string | null;
  buildArgs(o: RunOptions): string[];
  env?(o: RunOptions): Record<string, string>;
  /** Parse one line of the backend's JSONL stream into a normalised event. */
  parseLine(line: string): Pick<FleetEvent, "type" | "msg" | "data"> | null;
  /** Inspect combined output + exit code to decide whether the backend is spent. */
  detectExhaustion(text: string, exitCode: number | null): Exhaustion | null;
  /**
   * Optional: report a run that failed while still exiting 0. Returns the
   * reason, or null when the zero exit can be believed. Backends whose exit
   * code is trustworthy leave this unimplemented.
   */
  detectFailure?(text: string, exitCode: number | null): string | null;
}

export interface RunResult {
  backend: BackendId;
  runId: string;
  exitCode: number | null;
  /** Set when the backend exited 0 but its own output reported a failure. */
  failureReason?: string;
  /** Last assistant message, when the backend gives us one. */
  finalMessage: string;
  durationMs: number;
  exhaustion: Exhaustion | null;
  logPath: string;
}

export interface WorktreeRef {
  /** Absolute path of the source repository. */
  repo: string;
  /** Absolute path of the checked-out worktree the agent runs in. */
  path: string;
  branch: string;
  base: string;
  /** Branch tip recorded when cleanup removed the worktree. */
  head?: string;
}

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done", "complete"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface LedgerMeta {
  id: string;
  title: string;
  status: TaskStatus;
  /** Primary repo, or the parent folder of a multi-repo project. */
  repo: string;
  created: string;
  updated: string;
  /** ADO/issue number, when the branch convention wants one. */
  ticket?: string;
  /** Branch type segment: task | fix | feature | chore. */
  kind?: string;
  /** One entry per repo this task touches. Agents run inside these. */
  worktrees?: WorktreeRef[];
  /** Worktrees removed by cleanup, retained so orphan pruning can verify their branches. */
  removedWorktrees?: WorktreeRef[];
  /** Per-role backend override for this task. */
  routing?: Partial<Record<Role, BackendId[]>>;
}

export interface Ledger {
  meta: LedgerMeta;
  body: string;
  path: string;
}

export interface PolicyProject {
  trust?: "trusted" | "untrusted";
  /** Commands appended to the defaults for this project. */
  commands?: string[];
  /** Commands removed from the defaults for this project. */
  denyCommands?: string[];
  write?: boolean;
  network?: boolean;
  /** Extra writable roots (e.g. sibling worktrees). */
  writableRoots?: string[];
  /** Project-specific routing overrides; task-ledger overrides still win. */
  routing?: Partial<Record<Role, BackendId[]>>;
  /** Project-specific model/effort overrides. */
  models?: Partial<Record<BackendId, { model?: string; effort?: string }>>;
  /** Fallback stack for underspecified application tasks; false disables it. */
  applicationStack?: ApplicationStack | false;
  /** Project-specific Vibemin completion checks and guardrails. */
  vibemin?: Partial<VibeminPolicy>;

  // --- worktree & branch conventions ---
  /** Branch to cut new work from. Default: repo's origin/HEAD. */
  baseBranch?: string;
  /**
   * Branch naming template. Placeholders: {kind} {ticket} {slug}.
   * A `{ticket}` segment collapses cleanly when no ticket is supplied.
   * e.g. "{kind}/{ticket}-{slug}" -> "task/7899-fix-upload-modal"
   */
  branchPattern?: string;
  /** Default {kind} when the caller does not pass one. */
  defaultKind?: string;
  /**
   * Where worktrees for this project are created. Placeholders: {repoName} {slug} {taskId}.
   * Default: ~/.fleet/worktrees/{repoName}-{taskId}
   */
  worktreeRoot?: string;
  /**
   * For multi-repo folders: the sub-repos a task may span.
   * Paths relative to the project key, or absolute.
   */
  repos?: string[];
  /** Require a ticket number before a branch can be created. */
  requireTicket?: boolean;
}

export interface ApplicationStack {
  frontend?: string;
  backend?: string;
  delivery?: string;
  presentation?: string;
}

export interface VibeminPolicy {
  required: boolean;
  checks?: string[];
  preserveOutput?: string[];
  finalChecks?: string[];
  securityChecks?: string[];
  testStrengthChecks?: string[];
  dependencyChecks?: string[];
  allowTestChanges?: boolean;
  allowDependencyChanges?: boolean;
  allowVisualChanges?: boolean;
  allowUntypedTypescript?: boolean;
  maxAttempts: number;
  timeout: number;
}

export interface Policy {
  defaults: {
    commands: string[];
    denyCommands: string[];
    write: boolean;
    network: boolean;
    applicationStack: ApplicationStack | false;
  };
  /** Ordered backend preference per role. */
  routing: Record<Role, BackendId[]>;
  cooldown: {
    /** Default cooldown applied when we cannot parse a reset time, in minutes. */
    defaultMinutes: number;
    /** Cooldown after N consecutive hard failures, in minutes. */
    failureMinutes: number;
  };
  models: Partial<Record<BackendId, { model?: string; effort?: string }>>;
  projects: Record<string, PolicyProject>;
  notify: {
    /** Shell command receiving TITLE and MESSAGE env vars. */
    command?: string;
    /** Event types that trigger a desktop notification. */
    on: EventType[];
  };
  cleanup: {
    onDone: boolean;
    keepBranch: boolean;
    keepLedger: boolean;
    salvage: string[];
    salvageExclude: string[];
  };
  vibemin: VibeminPolicy;
}
