import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

export interface FleetEvent {
  ts: string;
  type: string;
  taskId: string;
  runId: string;
  backend: string;
  msg?: string;
  data?: unknown;
}

export class EventTail {
  private offset = 0;
  private identity = "";
  private carry = "";
  private decoder = new StringDecoder("utf8");
  private anchor = Buffer.alloc(0);
  private initialized = false;
  private discard = false;
  private pending?: Promise<void>;
  private path: string;
  private fromEnd: boolean;
  bytesRead = 0;

  constructor(path: string, fromEnd = true) {
    this.path = path;
    this.fromEnd = fromEnd;
  }

  poll(accept: (event: FleetEvent) => void): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.read(accept).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async read(accept: (event: FleetEvent) => void): Promise<void> {
    const file = await open(this.path, "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!file) {
      this.initialized = true;
      return;
    }
    try {
      const stat = await file.stat();
      const identity = `${stat.dev}:${stat.ino}`;
      let reset = identity !== this.identity || stat.size < this.offset;
      if (!reset && this.anchor.length) {
        const probe = Buffer.alloc(this.anchor.length);
        const { bytesRead } = await file.read(probe, 0, probe.length, this.offset - probe.length);
        this.bytesRead += bytesRead;
        reset = !probe.equals(this.anchor);
      }
      if (reset) {
        this.offset = !this.initialized && this.fromEnd ? stat.size : 0;
        this.carry = "";
        this.decoder = new StringDecoder("utf8");
        this.discard = false;
        if (this.offset) {
          const last = Buffer.alloc(1);
          this.bytesRead += (await file.read(last, 0, 1, this.offset - 1)).bytesRead;
          this.discard = last[0] !== 10;
        }
      }
      this.identity = identity;
      this.initialized = true;
      const buffer = Buffer.alloc(64 * 1024);
      while (this.offset < stat.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - this.offset), this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        this.bytesRead += bytesRead;
        const lines = (this.carry + this.decoder.write(buffer.subarray(0, bytesRead))).split("\n");
        this.carry = lines.pop() ?? "";
        for (const line of lines) {
          if (this.discard) {
            this.discard = false;
            continue;
          }
          let event: FleetEvent;
          try {
            event = JSON.parse(line) as FleetEvent;
          } catch {
            continue;
          }
          if (event && [event.ts, event.type, event.taskId, event.runId, event.backend].every((value) => typeof value === "string")) {
            accept(event);
          }
        }
      }
      this.anchor = Buffer.alloc(Math.min(64, this.offset));
      if (this.anchor.length) {
        this.bytesRead += (await file.read(this.anchor, 0, this.anchor.length, this.offset - this.anchor.length)).bytesRead;
      }
    } finally {
      await file.close();
    }
  }
}
