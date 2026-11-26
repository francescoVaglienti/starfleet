import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { EventTail } from "./events.ts";
import { eventLine, plain, singleLine } from "./activity.ts";
import { isTaskId, type Snapshot } from "./fleet.ts";

export function ledgerSections(body: string): string {
  const lines = body.split(/\r?\n/);
  const selected: string[] = [];
  let include = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) include = /^##\s+(Current state|Next)\s*$/.test(line);
    if (include) selected.push(line);
  }
  return plain(selected.join("\n").replace(/<!--[\s\S]*?-->/g, "").trim()) || "No Current state / Next sections yet.";
}

export class TaskView {
  private tail: EventTail;
  private ledgerPath: string;
  private ledger = "Loading ledger…";
  private signature = "";
  private events: string[] = [];
  private error = "";
  private width = 0;
  private wrappedEvents: string[] = [];
  private wrappedCount = 0;
  private scroll = Infinity;
  private pageHeight = 20;
  private total = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  readonly taskId: string;
  private requestRender: () => void;
  private close: () => void;
  private height: () => number;

  constructor(
    taskId: string,
    snapshot: Snapshot,
    cwd: string,
    requestRender: () => void,
    close: () => void,
    height: () => number,
  ) {
    if (!isTaskId(taskId)) throw new Error("Invalid Fleet task name.");
    this.taskId = taskId;
    this.requestRender = requestRender;
    this.close = close;
    this.height = height;
    this.tail = new EventTail(resolve(cwd, snapshot.paths.events), false);
    this.ledgerPath = join(resolve(cwd, snapshot.paths.ledgerDir), `${taskId}.md`);
  }

  async update(): Promise<void> {
    try {
      await this.tail.poll((event) => {
        if (!this.disposed && event.taskId === this.taskId) this.events.push(eventLine(event));
      });
      const info = await stat(this.ledgerPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      const signature = info ? `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}` : "missing";
      if (signature !== this.signature) {
        this.ledger = info ? ledgerSections(await readFile(this.ledgerPath, "utf8")) : "No ledger for this task.";
        this.signature = signature;
      }
      this.error = "";
    } catch (error) {
      this.error = plain((error as Error).message);
    }
    if (!this.disposed) this.requestRender();
  }

  start(): void {
    const tick = async () => {
      await this.update();
      if (!this.disposed) this.timer = setTimeout(tick, 400);
    };
    void tick();
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width);
    this.pageHeight = Math.max(1, Math.floor(this.height() * 0.8) - 3);
    if (this.width !== contentWidth) {
      this.width = contentWidth;
      this.wrappedEvents = [];
      this.wrappedCount = 0;
    }
    for (; this.wrappedCount < this.events.length; this.wrappedCount++) {
      this.wrappedEvents.push(...wrapTextWithAnsi(this.events[this.wrappedCount]!, contentWidth));
    }
    const sections = [
      [...wrapTextWithAnsi(this.ledger, contentWidth), "", "Events"],
      this.wrappedEvents,
      this.events.length ? [] : ["No events yet."],
      this.error ? wrapTextWithAnsi(this.error, contentWidth) : [],
    ];
    this.total = sections.reduce((total, section) => total + section.length, 0);
    const top = Math.max(0, Math.min(this.scroll, this.total - this.pageHeight));
    const page: string[] = [];
    let offset = 0;
    for (const section of sections) {
      const start = Math.max(0, top - offset);
      const end = Math.min(section.length, top + this.pageHeight - offset);
      if (start < end) page.push(...section.slice(start, end));
      offset += section.length;
    }
    return [
      truncateToWidth(`Fleet · ${singleLine(this.taskId)} · ${this.events.length} events`, contentWidth),
      ...page,
      truncateToWidth("↑/↓ scroll · PgUp/PgDn · Home ledger · End live · Esc close", contentWidth),
    ];
  }

  handleInput(data: string): void {
    const current = Math.max(0, Math.min(this.scroll, this.total - this.pageHeight));
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.close();
    if (matchesKey(data, "home")) this.scroll = 0;
    else if (matchesKey(data, "end")) this.scroll = Infinity;
    else if (matchesKey(data, "up")) this.scroll = Math.max(0, current - 1);
    else if (matchesKey(data, "down")) this.scroll = current + 1;
    else if (matchesKey(data, "pageUp")) this.scroll = Math.max(0, current - this.pageHeight);
    else if (matchesKey(data, "pageDown")) this.scroll = current + this.pageHeight;
    else return;
    this.requestRender();
  }

  invalidate(): void {
    this.width = 0;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }
}
