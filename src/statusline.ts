import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { P } from "./paths.js";

const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

interface StatusPayload {
  cwd?: string;
  workspace?: { current_dir?: string };
  model?: { display_name?: string };
}

function pidIsLive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function activeRuns(): Array<{ backend: string; taskId: string; runId: string; since: string; pid: number }> {
  if (!existsSync(P.stateDir)) return [];
  const runs: ReturnType<typeof activeRuns> = [];
  for (const name of readdirSync(P.stateDir).filter((item) => item.startsWith("lock-") && item.endsWith(".json"))) {
    try {
      const data = JSON.parse(readFileSync(join(P.stateDir, name), "utf8")) as Record<string, unknown>;
      if (!pidIsLive(data.pid)) continue;
      runs.push({
        backend: String(data.backend ?? "?"),
        taskId: String(data.taskId ?? "?"),
        runId: String(data.runId ?? ""),
        since: typeof data.since === "string" ? data.since : "",
        pid: data.pid as number,
      });
    } catch {
      // A partial or stale lock should never break the prompt.
    }
  }
  return runs.sort((left, right) => left.since.localeCompare(right.since) || left.runId.localeCompare(right.runId));
}

export function liveRuns(now = Date.now()): Array<[string, string, number]> {
  return activeRuns().map((run) => {
    const started = Date.parse(run.since);
    const minutes = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 60_000)) : 0;
    return [run.backend, run.taskId, minutes];
  });
}

function branch(cwd: string): string {
  let git = join(cwd, ".git");
  try {
    if (!existsSync(git)) return "";
    const stat = readFileSync(git, "utf8");
    const pointer = stat.split("gitdir:", 2)[1]?.trim();
    if (pointer) git = isAbsolute(pointer) ? pointer : resolve(cwd, pointer);
  } catch {
    // Normal repositories have a .git directory, which cannot be read as a file.
  }
  try {
    const head = readFileSync(join(git, "HEAD"), "utf8").trim();
    return head.startsWith("ref:") ? head.split("/").at(-1) ?? "" : head.slice(0, 7);
  } catch {
    return "";
  }
}

export function renderStatusline(payload: StatusPayload, now = Date.now()): string {
  const cwd = payload.workspace?.current_dir || payload.cwd || process.cwd();
  const parts = [`${CYAN}${basename(cwd)}${RESET}`];
  const currentBranch = branch(cwd);
  if (currentBranch) parts.push(`${DIM}${currentBranch}${RESET}`);
  if (payload.model?.display_name) parts.push(`${DIM}${payload.model.display_name}${RESET}`);

  const runs = liveRuns(now);
  if (runs.length) {
    const detail = runs.map(([backend, task, minutes]) => `${backend}:${task} ${minutes}m`).join(", ");
    parts.push(`${YELLOW}⏳ fleet ${runs.length} · ${detail}${RESET}`);
  } else {
    parts.push(`${GREEN}● fleet idle${RESET}`);
  }
  return parts.join(" │ ");
}
