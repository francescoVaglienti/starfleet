import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

export const toolNames = new Set([
  "fleet_status", "fleet_task_new", "fleet_delegate", "fleet_checkpoint", "fleet_ledger_read",
  "fleet_events", "fleet_route_preview", "fleet_task_done", "fleet_worktrees", "fleet_clear_cooldown",
]);

export interface Run {
  backend: string;
  taskId: string;
  runId: string;
  since: string;
  pid?: number;
}

export interface Snapshot {
  schemaVersion: 1;
  paths: { events: string; ledgerDir: string };
  runs: Run[];
  backends: Array<{ id: string; cooldownUntil: string | null }>;
  tasks: Array<{ id: string; title: string; status: string }>;
}

const installHint = "Fleet could not start. Install fleet-ai with `pnpm add -g fleet-ai` or `uv tool install fleet-ai`, and ensure `fleet` is on PATH.";

export function fleetError(error: unknown): Error {
  return new Error(`${installHint}\n${error instanceof Error ? error.message : String(error)}`);
}

export function isTaskId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
}

export async function withFleet<T>(cwd: string, action: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "pi-fleet", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "fleet",
    args: ["mcp"],
    cwd,
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  try {
    try {
      await client.connect(transport, { timeout: 15_000 });
    } catch (error) {
      throw fleetError(error);
    }
    return await action(client);
  } finally {
    await client.close();
  }
}

export function callFleet(cwd: string, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  for (const field of ["taskId", "task_id", "id"]) {
    const value = args[field];
    if (value !== undefined && value !== null && !isTaskId(value)) {
      throw new Error(`${field} must be a task name, without slashes or path traversal.`);
    }
  }
  signal?.throwIfAborted();
  const delegation = name === "fleet_delegate" && args.wait !== false;
  const operation = withFleet(cwd, (client) => client.request(
    { method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema,
    { signal: delegation ? undefined : signal, timeout: delegation ? 24 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000 + 60_000 },
  ));
  if (!delegation || !signal) return operation;
  return new Promise<Awaited<typeof operation>>((resolve, reject) => {
    const abort = () => reject(new Error("Stopped waiting. Fleet continues in the background with its worktree lock; follow it with /fleet or fleet_events."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function readSnapshot(cwd: string, signal?: AbortSignal): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    execFile("fleet", ["status", "--json"], { cwd, signal, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(fleetError(new Error(stderr.trim() || error.message)));
      try {
        const snapshot = JSON.parse(stdout) as Snapshot;
        if (snapshot?.schemaVersion !== 1) {
          throw new Error("Live Fleet activity needs `fleet status --json` schema 1. Update your fleet-ai installation.");
        }
        if (!Array.isArray(snapshot.runs) || snapshot.runs.some((run) => !run
            || ![run.backend, run.taskId, run.runId, run.since].every((value) => typeof value === "string")
            || !Number.isInteger(run.pid) || run.pid! <= 0)
          || !Array.isArray(snapshot.backends) || snapshot.backends.some((backend) => !backend
            || typeof backend.id !== "string" || (backend.cooldownUntil !== null && typeof backend.cooldownUntil !== "string"))
          || !Array.isArray(snapshot.tasks) || snapshot.tasks.some((task) => !task
            || ![task.id, task.title, task.status].every((value) => typeof value === "string"))
          || typeof snapshot.paths?.events !== "string" || typeof snapshot.paths?.ledgerDir !== "string") {
          throw new Error("Malformed Fleet status: invalid run, backend, task or state paths.");
        }
        resolve(snapshot);
      } catch (error) {
        reject(error instanceof SyntaxError
          ? new Error(`Fleet status did not return valid JSON; check that fleet-ai supports --json. ${error.message}`)
          : error);
      }
    });
  });
}
