import type { Backend, BackendId } from "../types.js";
import { claudeBackend } from "./claude.js";
import { codexBackend } from "./codex.js";
import { copilotBackend } from "./copilot.js";
import { antigravityBackend } from "./antigravity.js";
import { mimoBackend } from "./mimo.js";
import { piBackend } from "./pi.js";

export const BACKENDS: Record<BackendId, Backend> = {
  claude: claudeBackend,
  codex: codexBackend,
  copilot: copilotBackend,
  antigravity: antigravityBackend,
  mimo: mimoBackend,
  pi: piBackend,
};

export function getBackend(id: BackendId): Backend {
  return BACKENDS[id];
}

export function installedBackends(): BackendId[] {
  return (Object.keys(BACKENDS) as BackendId[]).filter((id) => BACKENDS[id].resolveBin() !== null);
}
