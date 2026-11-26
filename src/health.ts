import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { P, ensureDirs } from "./paths.js";
import type { BackendId, Exhaustion, HealthFile, BackendHealth } from "./types.js";

const DEFAULT: BackendHealth = { state: "ok", consecutiveFailures: 0 };

export function loadHealth(): HealthFile {
  ensureDirs();
  if (!existsSync(P.health)) return {};
  try {
    return JSON.parse(readFileSync(P.health, "utf8")) as HealthFile;
  } catch {
    return {};
  }
}

export function saveHealth(h: HealthFile): void {
  ensureDirs();
  writeFileSync(P.health, JSON.stringify(h, null, 2) + "\n");
}

export function getHealth(id: BackendId): BackendHealth {
  return loadHealth()[id] ?? { ...DEFAULT };
}

/** True when the backend is currently cooling down. Expired cooldowns self-clear. */
export function isAvailable(id: BackendId): boolean {
  const h = getHealth(id);
  if (h.state !== "cooldown") return h.state === "ok";
  if (!h.cooldownUntil) return true;
  if (new Date(h.cooldownUntil).getTime() <= Date.now()) {
    clearCooldown(id);
    return true;
  }
  return false;
}

export function markExhausted(id: BackendId, ex: Exhaustion): void {
  const h = loadHealth();
  const prev = h[id] ?? { ...DEFAULT };
  h[id] = {
    ...prev,
    state: "cooldown",
    reason: `${ex.kind}: ${ex.detail}`.slice(0, 300),
    cooldownUntil: new Date(Date.now() + ex.retryAfterMs).toISOString(),
    lastRunAt: new Date().toISOString(),
    consecutiveFailures: prev.consecutiveFailures + 1,
  };
  saveHealth(h);
}

export function markSuccess(id: BackendId, exitCode: number | null): void {
  const h = loadHealth();
  h[id] = {
    state: "ok",
    lastRunAt: new Date().toISOString(),
    lastResolvedModel: h[id]?.lastResolvedModel,
    lastExitCode: exitCode,
    consecutiveFailures: 0,
  };
  saveHealth(h);
}

export function recordResolvedModel(id: BackendId, model: string): void {
  const health = loadHealth();
  health[id] = { ...(health[id] ?? DEFAULT), lastResolvedModel: model };
  saveHealth(health);
}

export function markFailure(id: BackendId, exitCode: number | null, cooldownMinutes: number): void {
  const h = loadHealth();
  const prev = h[id] ?? { ...DEFAULT };
  const fails = prev.consecutiveFailures + 1;
  // Only cool a backend down for plain errors once it has failed repeatedly —
  // a single non-zero exit is usually the task's fault, not the backend's.
  const cooling = fails >= 3;
  h[id] = {
    ...prev,
    state: cooling ? "cooldown" : "ok",
    reason: cooling ? `${fails} consecutive failures (exit ${exitCode})` : undefined,
    cooldownUntil: cooling
      ? new Date(Date.now() + cooldownMinutes * 60_000).toISOString()
      : undefined,
    lastRunAt: new Date().toISOString(),
    lastExitCode: exitCode,
    consecutiveFailures: fails,
  };
  saveHealth(h);
}

export function clearCooldown(id: BackendId): void {
  const h = loadHealth();
  const prev = h[id] ?? { ...DEFAULT };
  h[id] = { ...prev, state: "ok", reason: undefined, cooldownUntil: undefined };
  saveHealth(h);
}

export function clearAll(): void {
  saveHealth({});
}

export function cooldownRemaining(id: BackendId): number {
  const h = getHealth(id);
  if (h.state !== "cooldown" || !h.cooldownUntil) return 0;
  return Math.max(0, new Date(h.cooldownUntil).getTime() - Date.now());
}
