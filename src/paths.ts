import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const HOME = homedir();
export const FLEET_HOME = process.env.FLEET_HOME ?? join(HOME, ".fleet");

export const P = {
  home: FLEET_HOME,
  policy: join(FLEET_HOME, "policy.yaml"),
  events: join(FLEET_HOME, "events.jsonl"),
  health: join(FLEET_HOME, "state", "health.json"),
  managed: join(FLEET_HOME, "state", "managed.json"),
  mute: join(FLEET_HOME, "state", "mute.json"),
  ledgerDir: join(FLEET_HOME, "ledger"),
  logDir: join(FLEET_HOME, "logs"),
  stateDir: join(FLEET_HOME, "state"),
  backupDir: join(FLEET_HOME, "backups"),
  worktreeDir: join(FLEET_HOME, "worktrees"),

  claudeSettings: join(HOME, ".claude", "settings.json"),
  codexConfig: join(HOME, ".codex", "config.toml"),
  codexRules: join(HOME, ".codex", "rules", "fleet.rules"),
  copilotPermissions: join(HOME, ".copilot", "permissions-config.json"),
  copilotConfig: join(HOME, ".copilot", "config.json"),
};

export function ensureDirs(): void {
  for (const d of [
    P.home,
    P.ledgerDir,
    P.logDir,
    P.stateDir,
    P.backupDir,
    P.worktreeDir,
  ]) {
    mkdirSync(d, { recursive: true });
  }
}

export function ledgerPath(taskId: string): string {
  return join(P.ledgerDir, `${taskId}.md`);
}

export function runLogPath(taskId: string, runId: string): string {
  return join(P.logDir, `${taskId}__${runId}.jsonl`);
}

export function piSessionDir(taskId: string): string {
  return join(P.home, "sessions", "pi", `task-${encodeURIComponent(taskId)}`);
}
