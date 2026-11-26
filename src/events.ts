import {
  appendFileSync,
  createReadStream,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { P, ensureDirs } from "./paths.js";
import type { EventType, FleetEvent, BackendId } from "./types.js";

let notifyConfig: { command?: string; on: EventType[] } | null = null;

export interface MuteState {
  since: string;
  until: string | null;
}

export function configureNotify(cfg: { command?: string; on: EventType[] }): void {
  notifyConfig = cfg;
}

export function readMute(): MuteState | null {
  try {
    const parsed = JSON.parse(readFileSync(P.mute, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const state = parsed as Partial<MuteState>;
    if (typeof state.since !== "string" || !Number.isFinite(Date.parse(state.since))) return null;
    if (state.until !== null && typeof state.until !== "string") return null;
    if (state.until !== null) {
      const until = Date.parse(state.until);
      if (!Number.isFinite(until)) return null;
      if (until <= Date.now()) {
        unlinkSync(P.mute);
        return null;
      }
    }
    return { since: state.since, until: state.until };
  } catch {
    return null;
  }
}

export function setMute(until: Date | null): MuteState {
  const state: MuteState = {
    since: new Date().toISOString(),
    until: until?.toISOString() ?? null,
  };
  try {
    ensureDirs();
    writeFileSync(P.mute, JSON.stringify(state, null, 2) + "\n");
  } catch (error) {
    throw new Error(`could not write mute state: ${(error as Error).message}`);
  }
  return state;
}

export function clearMute(): boolean {
  const active = readMute() !== null;
  try {
    unlinkSync(P.mute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`could not clear mute state: ${(error as Error).message}`);
    }
  }
  return active;
}

/** Append one event to the central bus, plus the per-run log when given. */
export function emit(
  ev: Omit<FleetEvent, "ts"> & { ts?: string },
  runLog?: string,
): FleetEvent {
  ensureDirs();
  const full: FleetEvent = { ts: ev.ts ?? new Date().toISOString(), ...ev };
  const line = JSON.stringify(full) + "\n";
  appendFileSync(P.events, line);
  if (runLog) appendFileSync(runLog, line);
  maybeNotify(full);
  return full;
}

function maybeNotify(ev: FleetEvent): void {
  if (readMute()) return;
  if (!notifyConfig?.command) return;
  if (!notifyConfig.on.includes(ev.type)) return;
  const title = `fleet · ${ev.backend} · ${ev.taskId}`;
  const message = (ev.msg ?? ev.type).slice(0, 240);
  try {
    const child = spawn("/bin/sh", ["-c", notifyConfig.command], {
      env: { ...process.env, FLEET_TITLE: title, FLEET_MESSAGE: message, FLEET_EVENT: ev.type },
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch {
    /* notification failure must never break a run */
  }
}

export interface ReadOpts {
  taskId?: string;
  backend?: BackendId | "fleet";
  types?: EventType[];
  limit?: number;
}

/** Read the tail of the event bus. Streams so a large log stays cheap. */
export async function readEvents(opts: ReadOpts = {}): Promise<FleetEvent[]> {
  if (!existsSync(P.events)) return [];
  const out: FleetEvent[] = [];
  const rl = createInterface({
    input: createReadStream(P.events, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let ev: FleetEvent;
    try {
      ev = JSON.parse(line) as FleetEvent;
    } catch {
      continue;
    }
    if (opts.taskId && ev.taskId !== opts.taskId) continue;
    if (opts.backend && ev.backend !== opts.backend) continue;
    if (opts.types && !opts.types.includes(ev.type)) continue;
    out.push(ev);
  }
  return opts.limit ? out.slice(-opts.limit) : out;
}

/** Follow the bus, invoking `onEvent` for each new line. Never resolves. */
export async function tailEvents(
  onEvent: (ev: FleetEvent) => void,
  opts: ReadOpts = {},
): Promise<never> {
  ensureDirs();
  let offset = existsSync(P.events) ? statSync(P.events).size : 0;
  let carry = "";

  const matches = (ev: FleetEvent): boolean => {
    if (opts.taskId && ev.taskId !== opts.taskId) return false;
    if (opts.backend && ev.backend !== opts.backend) return false;
    if (opts.types && !opts.types.includes(ev.type)) return false;
    return true;
  };

  for (;;) {
    await sleep(400);
    if (!existsSync(P.events)) continue;
    const size = statSync(P.events).size;
    if (size < offset) {
      // truncated / rotated
      offset = 0;
      carry = "";
    }
    if (size === offset) continue;
    const chunk = await readRange(P.events, offset, size);
    offset = size;
    const text = carry + chunk;
    const lines = text.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as FleetEvent;
        if (matches(ev)) onEvent(ev);
      } catch {
        /* partial write; skip */
      }
    }
  }
}

function readRange(path: string, start: number, end: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const s = createReadStream(path, { start, end: end - 1 });
    s.on("data", (c) => chunks.push(c as Buffer));
    s.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    s.on("error", reject);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
