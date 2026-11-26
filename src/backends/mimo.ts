import type { Backend, RunOptions } from "../types.js";
import { claudeBackend } from "./claude.js";

export const MIMO_ANTHROPIC_BASE_URL = "https://token-plan-ams.xiaomimimo.com/anthropic";

export const mimoBackend: Backend = {
  ...claudeBackend,
  id: "mimo",
  displayName: "MiMo (Claude Code)",

  buildArgs(o: RunOptions): string[] {
    return claudeBackend.buildArgs({ ...o, effort: undefined });
  },

  env(): Record<string, string> {
    const key = process.env.MIMO_API_KEY?.trim();
    if (!key) throw new Error("MiMo requires MIMO_API_KEY before starting a run");
    return {
      ANTHROPIC_BASE_URL: MIMO_ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: key,
      CLAUDE_CODE_OAUTH_TOKEN: "",
      ANTHROPIC_API_KEY: "",
    };
  },
};
