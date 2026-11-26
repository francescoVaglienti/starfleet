import type { Backend, FleetEvent, RunOptions } from "../types.js";
import { arr, digText, obj, safeJson, str, which, detectExhaustionGeneric } from "./common.js";

type Parsed = Pick<FleetEvent, "type" | "msg" | "data"> | null;

export const claudeBackend: Backend = {
  id: "claude",
  displayName: "Claude Code",
  bin: "claude",

  resolveBin() {
    return which("claude");
  },

  buildArgs(o: RunOptions): string[] {
    const args = [
      "-p",
      o.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      o.readOnly ? "plan" : "bypassPermissions",
    ];
    if (o.readOnly) {
      args.push("--tools", "Read,Glob,Grep", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--safe-mode", "--setting-sources", "", "--settings", '{"disableAllHooks":true}',
        "--permission-prompts", "none", "--disable-slash-commands", "--no-chrome");
    }
    if (o.model) args.push("--model", o.model);
    if (o.effort) args.push("--effort", o.effort);
    if (!o.readOnly) for (const d of o.extraDirs ?? []) args.push("--add-dir", d);
    return args;
  },

  parseLine(line: string): Parsed {
    const j = safeJson(line);
    if (!j) return null;
    const type = str(j["type"]);

    if (type === "assistant") {
      const message = obj(j["message"]);
      const content = arr(message?.["content"]) ?? [];
      for (const block of content) {
        const b = obj(block);
        if (!b) continue;
        if (b["type"] === "tool_use") {
          const name = str(b["name"]) ?? "tool";
          return { type: "tool.use", msg: name, data: { name, input: b["input"] } };
        }
        if (b["type"] === "text") {
          const text = str(b["text"]);
          if (text?.trim()) return { type: "agent.text", msg: text };
        }
        if (b["type"] === "thinking") {
          return { type: "agent.reasoning", msg: digText(b) ?? "" };
        }
      }
      return null;
    }

    if (type === "user") {
      const message = obj(j["message"]);
      const content = arr(message?.["content"]) ?? [];
      for (const block of content) {
        const b = obj(block);
        if (b?.["type"] === "tool_result") {
          const isErr = b["is_error"] === true;
          return {
            type: "tool.result",
            msg: isErr ? "tool error" : "tool ok",
            data: { is_error: isErr },
          };
        }
      }
      return null;
    }

    if (type === "result") {
      const isError = j["is_error"] === true;
      return {
        type: isError ? "run.error" : "run.end",
        msg: str(j["result"]) ?? str(j["subtype"]) ?? "result",
        data: {
          subtype: j["subtype"],
          cost_usd: j["total_cost_usd"],
          duration_ms: j["duration_ms"],
          num_turns: j["num_turns"],
          usage: j["usage"],
        },
      };
    }

    if (type === "system") return null;
    return null;
  },

  detectExhaustion(text, exitCode) {
    // Claude's 5-hour window resets on a rolling basis; 30m is a sensible probe
    // interval rather than a claim about when the window actually reopens.
    return detectExhaustionGeneric(text, exitCode, 30 * 60_000);
  },
};

/** Pull the final assistant answer out of a Claude stream-json transcript. */
export function claudeFinalMessage(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const j = safeJson(lines[i] ?? "");
    if (j && str(j["type"]) === "result") {
      const r = str(j["result"]);
      if (r) return r;
    }
  }
  return "";
}
