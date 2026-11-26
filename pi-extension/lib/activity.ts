import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { EventTail, type FleetEvent } from "./events.ts";
import { readSnapshot, type Run, type Snapshot } from "./fleet.ts";

export function plain(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}

export function singleLine(value: string): string {
  return plain(value).replace(/\s+/g, " ").trim();
}

export function elapsed(since: string, now = Date.now()): string {
  const started = Date.parse(since);
  if (!Number.isFinite(started)) return "-";
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function eventLine(event: FleetEvent): string {
  const message = typeof event.msg === "string" ? event.msg : "";
  return plain(`${event.ts} ${event.backend} ${event.type} ${message}${event.data === undefined ? "" : ` ${JSON.stringify(event.data)}`}`).trim();
}

export class Activity {
  snapshot?: Snapshot;
  error?: string;
  runs = new Map<string, Run>();
  latest = new Map<string, FleetEvent>();
  private listeners = new Set<() => void>();
  private tail?: EventTail;
  private timer?: ReturnType<typeof setTimeout>;
  private controller = new AbortController();
  private refreshAt = 0;
  private refreshing?: Promise<void>;
  private revision = 0;
  private changes = new Map<string, number>();
  private completed = new Set<string>();
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  changed(): void {
    if (!this.controller.signal.aborted) for (const listener of this.listeners) listener();
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const revision = this.revision;
    this.refreshing = (async () => {
      try {
        const snapshot = await readSnapshot(this.cwd, this.controller.signal);
        if (this.controller.signal.aborted) return;
        if (!this.tail) {
          this.tail = new EventTail(resolve(this.cwd, snapshot.paths.events));
          await this.tail.poll((event) => this.accept(event));
        }
        this.snapshot = snapshot;
        const runs = new Map(snapshot.runs.map((run) => [run.runId || `${run.backend}:${run.taskId}`, run]));
        const unchanged = (id: string) => (this.changes.get(id) ?? 0) <= revision;
        for (const id of this.runs.keys()) {
          if (unchanged(id) && !runs.has(id)) this.runs.delete(id);
        }
        for (const [id, run] of runs) if (unchanged(id) && !this.completed.has(id)) this.runs.set(id, run);
        for (const id of this.completed) if (unchanged(id) && !runs.has(id)) this.completed.delete(id);
        for (const id of this.changes.keys()) if (unchanged(id)) this.changes.delete(id);
        for (const id of this.latest.keys()) if (!this.runs.has(id)) this.latest.delete(id);
        this.error = undefined;
      } catch (error) {
        if (!this.controller.signal.aborted) this.error = (error as Error).message;
      } finally {
        this.refreshAt = Date.now() + 5000;
        this.refreshing = undefined;
        this.changed();
      }
    })();
    return this.refreshing;
  }

  accept(event: FleetEvent): void {
    const id = event.runId || `${event.backend}:${event.taskId}`;
    if (["run.start", "run.end", "run.error"].includes(event.type)) this.changes.set(id, ++this.revision);
    if (event.type === "run.start" && !this.runs.has(id)) {
      this.runs.set(id, { backend: event.backend, taskId: event.taskId, runId: event.runId, since: event.ts });
    }
    if (this.runs.has(id)) this.latest.set(id, event);
    if (event.type === "run.end" || event.type === "run.error") {
      this.completed.add(id);
      this.runs.delete(id);
      this.latest.delete(id);
    }
    if (["exhausted", "failover", "run.end", "run.error"].includes(event.type)) this.refreshAt = 0;
    this.changed();
  }

  async start(): Promise<void> {
    await this.refresh();
    const tick = async () => {
      if (this.controller.signal.aborted) return;
      if (Date.now() >= this.refreshAt) void this.refresh();
      try {
        await this.tail?.poll((event) => this.accept(event));
      } catch (error) {
        this.error = (error as Error).message;
      }
      this.changed();
      if (!this.controller.signal.aborted) this.timer = setTimeout(tick, 400);
    };
    if (!this.controller.signal.aborted) this.timer = setTimeout(tick, 400);
  }

  stop(): void {
    this.controller.abort();
    clearTimeout(this.timer);
    this.listeners.clear();
  }
}

export function statusText(activity: Activity, now = Date.now()): string {
  if (activity.error) return `fleet unavailable · ${singleLine(activity.error)}`;
  if (!activity.snapshot) return "fleet loading";
  const runs = [...activity.runs.values()];
  const parts = [runs.length ? `fleet ${runs.length} running · ${runs.map((run) => `${singleLine(run.backend)}:${singleLine(run.taskId)} ${elapsed(run.since, now)}`).join(", ")}` : "fleet idle"];
  const cooldowns = activity.snapshot.backends.filter((backend) => backend.cooldownUntil && Date.parse(backend.cooldownUntil) > now);
  if (cooldowns.length) parts.push(`cooldown ${cooldowns.map((backend) => `${singleLine(backend.id)} ${Math.ceil((Date.parse(backend.cooldownUntil!) - now) / 60_000)}m`).join(", ")}`);
  return parts.join(" | ");
}

export function widgetLines(activity: Activity, now = Date.now()): string[] {
  if (activity.error) return [singleLine(activity.error)];
  return [...activity.runs.entries()].map(([id, run]) => {
    const event = activity.latest.get(id);
    const latest = event ? `${event.type} ${typeof event.msg === "string" ? event.msg : JSON.stringify(event.data ?? "")}` : "waiting for events";
    return `${singleLine(run.backend)}  ${singleLine(run.taskId)}  ${elapsed(run.since, now)}  ${singleLine(latest)}`;
  });
}
