import { execFileSync } from "node:child_process";
import type { Exhaustion } from "../types.js";

export function which(bin: string): string | null {
  try {
    return execFileSync("/usr/bin/which", [bin], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

export function safeJson(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export function arr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

/**
 * Pull the first plausible human-readable string out of an unknown event shape.
 * The Codex and Copilot JSONL schemas are explicitly experimental, so we probe
 * a list of likely keys rather than hard-coding one layout.
 */
export function digText(v: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (typeof v === "string") return v;
  const o = obj(v);
  if (!o) return undefined;
  for (const key of ["text", "message", "content", "delta", "result", "output", "summary"]) {
    const hit = o[key];
    if (typeof hit === "string" && hit.trim()) return hit;
    if (hit !== undefined) {
      const nested = digText(hit, depth + 1);
      if (nested) return nested;
    }
  }
  const list = arr(v);
  if (list) {
    for (const item of list) {
      const nested = digText(item, depth + 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

const RATE_LIMIT_PATTERNS: Array<{ re: RegExp; kind: Exhaustion["kind"] }> = [
  { re: /usage limit reached/i, kind: "rate_limit" },
  { re: /rate[_ -]?limit(ed|_error)?/i, kind: "rate_limit" },
  { re: /\b429\b/, kind: "rate_limit" },
  { re: /too many requests/i, kind: "rate_limit" },
  { re: /you(?:'ve| have) (?:hit|reached) your .{0,40}limit/i, kind: "rate_limit" },
  { re: /quota (?:exceeded|exhausted)/i, kind: "quota" },
  { re: /out of (?:premium )?(?:requests|credits)/i, kind: "quota" },
  { re: /insufficient (?:credits|quota)/i, kind: "quota" },
  { re: /no (?:remaining|available) credits/i, kind: "quota" },
  { re: /monthly (?:limit|allowance) reached/i, kind: "quota" },
  { re: /premium request.{0,30}(?:limit|exhaust)/i, kind: "quota" },
  { re: /\b401\b|unauthorized|not (?:logged in|authenticated)/i, kind: "auth" },
  { re: /invalid api key|authentication[_ ]error|please run .{0,20}login/i, kind: "auth" },
];

/**
 * Best-effort extraction of when a limit resets. Returns ms from now.
 * Vendors phrase this many ways and change it often, so a miss falls back to
 * the policy default rather than pretending to know.
 */
export function parseRetryAfter(text: string): number | null {
  const relative = text.match(
    /(?:try again|retry|resets?|available again)(?:\s+\w+){0,3}\s+(\d+)\s*(second|minute|hour)s?/i,
  );
  if (relative?.[1] && relative[2]) {
    const n = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const mult = unit === "second" ? 1_000 : unit === "minute" ? 60_000 : 3_600_000;
    return n * mult;
  }

  const header = text.match(/retry[- _]after["':\s]+(\d+)/i);
  if (header?.[1]) return Number(header[1]) * 1_000;

  // "resets at 3pm", "try again at 15:04"
  const clock = text.match(/(?:resets?|try again|available)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (clock?.[1]) {
    const now = new Date();
    let hour = Number(clock[1]);
    const min = clock[2] ? Number(clock[2]) : 0;
    const ampm = clock[3]?.toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    const target = new Date(now);
    target.setHours(hour, min, 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    const delta = target.getTime() - now.getTime();
    if (delta > 0 && delta < 24 * 3_600_000) return delta;
  }
  return null;
}

export function detectExhaustionGeneric(
  text: string,
  exitCode: number | null,
  defaultMs: number,
): Exhaustion | null {
  if (exitCode === 0) return null;
  // Only inspect the tail: earlier output may legitimately discuss rate limits
  // (e.g. the agent reading code about retries) without the backend being spent.
  const tail = text.slice(-8_000);
  for (const { re, kind } of RATE_LIMIT_PATTERNS) {
    const m = tail.match(re);
    if (!m) continue;
    const around = tail.slice(Math.max(0, (m.index ?? 0) - 200), (m.index ?? 0) + 300);
    return {
      kind,
      retryAfterMs: parseRetryAfter(tail) ?? (kind === "auth" ? 5 * 60_000 : defaultMs),
      detail: around.replace(/\s+/g, " ").trim().slice(0, 300),
    };
  }
  return null;
}
