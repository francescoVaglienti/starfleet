import type { Backend, FleetEvent, RunOptions } from "../types.js";
import { digText, obj, safeJson, str, which, detectExhaustionGeneric } from "./common.js";

type Parsed = Pick<FleetEvent, "type" | "msg" | "data"> | null;

/**
 * Codex's `exec --json` schema is explicitly experimental and has already
 * changed shape once (`{msg:{type}}` -> `{type:"item.completed",item:{...}}`).
 * We probe both layouts and degrade to a generic event rather than dropping
 * output when a third shape appears.
 */
export const codexBackend: Backend = {
  id: "codex",
  displayName: "Codex",
  bin: "codex",

  resolveBin() {
    return which("codex");
  },

  buildArgs(o: RunOptions): string[] {
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      o.cwd,
      "-s",
      o.readOnly ? "read-only" : "workspace-write",
    ];
    if (o.readOnly) args.push("--ignore-user-config", "--ignore-rules", "-c", 'approval_policy="never"',
      "-c", "mcp_servers={}", "-c", "agents.enabled=false", "-c", "features.apps=false");
    if (o.model) args.push("-m", o.model);
    if (o.effort) args.push("-c", `model_reasoning_effort="${o.effort}"`);
    if (!o.readOnly) for (const d of o.extraDirs ?? []) args.push("--add-dir", d);
    args.push(o.prompt);
    return args;
  },

  parseLine(line: string): Parsed {
    const j = safeJson(line);
    if (!j) return null;

    // Newer item-based schema.
    const topType = str(j["type"]);
    if (topType?.startsWith("item.")) {
      const item = obj(j["item"]);
      const itemType = str(item?.["type"]) ?? "item";
      if (topType === "item.started" || topType === "item.updated") {
        if (itemType === "command_execution") {
          return {
            type: "tool.use",
            msg: str(item?.["command"]) ?? "command",
            data: item,
          };
        }
        return null;
      }
      // item.completed
      if (itemType === "agent_message") {
        return { type: "agent.text", msg: digText(item) ?? "" };
      }
      if (itemType === "reasoning") {
        return { type: "agent.reasoning", msg: digText(item) ?? "" };
      }
      if (itemType === "command_execution") {
        const code = item?.["exit_code"];
        return {
          type: "tool.result",
          msg: code === 0 || code === undefined ? "command ok" : `command exit ${String(code)}`,
          data: { exit_code: code },
        };
      }
      if (itemType === "file_change" || itemType === "patch_apply") {
        return { type: "tool.use", msg: "edit", data: item };
      }
      return { type: "tool.result", msg: itemType, data: item };
    }

    if (topType === "turn.completed") {
      return { type: "run.end", msg: "turn complete", data: j["usage"] };
    }
    if (topType === "turn.failed" || topType === "error") {
      return { type: "run.error", msg: digText(j) ?? "error", data: j };
    }
    if (topType === "thread.started") return null;

    // Older msg-based schema.
    const msg = obj(j["msg"]);
    if (msg) {
      const mt = str(msg["type"]) ?? "";
      if (mt === "agent_message") return { type: "agent.text", msg: digText(msg) ?? "" };
      if (mt === "agent_reasoning") return { type: "agent.reasoning", msg: digText(msg) ?? "" };
      if (mt === "exec_command_begin") {
        return { type: "tool.use", msg: digText(msg) ?? "command", data: msg };
      }
      if (mt === "exec_command_end") {
        return { type: "tool.result", msg: "command done", data: msg };
      }
      if (mt === "error") return { type: "run.error", msg: digText(msg) ?? "error", data: msg };
      if (mt === "task_complete") return { type: "run.end", msg: "task complete", data: msg };
      return null;
    }

    return null;
  },

  detectExhaustion(text, exitCode) {
    return detectExhaustionGeneric(text, exitCode, 30 * 60_000);
  },
};
