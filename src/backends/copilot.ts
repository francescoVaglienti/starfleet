import type { Backend, FleetEvent, RunOptions } from "../types.js";
import { arr, digText, obj, safeJson, str, which, detectExhaustionGeneric } from "./common.js";

type Parsed = Pick<FleetEvent, "type" | "msg" | "data"> | null;

export const copilotBackend: Backend = {
  id: "copilot",
  displayName: "GitHub Copilot",
  bin: "copilot",

  resolveBin() {
    return which("copilot");
  },

  buildArgs(o: RunOptions): string[] {
    const args = [
      "-p",
      o.prompt,
      "--output-format",
      "json",
      "--no-ask-user",
      "--no-color",
      "-C",
      o.cwd,
    ];
    if (o.readOnly) {
      args.push("--mode", "plan", "--available-tools", "view,grep,glob", "--allow-tool", "read",
        "--deny-tool", "shell", "--deny-tool", "write", "--disable-builtin-mcps", "--no-experimental");
    } else {
      args.push("--allow-all-paths", "--allow-all-tools");
    }
    if (!o.readOnly) for (const d of o.extraDirs ?? []) args.push("--add-dir", d);
    if (o.model) args.push("--model", o.model);
    if (o.effort) args.push("--reasoning-effort", o.effort);
    return args;
  },

  parseLine(line: string): Parsed {
    const j = safeJson(line);
    if (!j) return null;

    // Verified schema (CLI 1.0.78): {type, data, ephemeral?, id, timestamp, parentId}.
    // `ephemeral` marks streaming deltas — one tool call produces dozens of
    // `assistant.tool_call_delta` frames, so keeping them would drown the log.
    if (j["ephemeral"] === true) return null;

    const t = str(j["type"]);
    const d = obj(j["data"]);
    if (t && d) {
      switch (t) {
        case "tool.execution_start": {
          const name = str(d["toolName"]) ?? "tool";
          const a = obj(d["arguments"]);
          const detail = a
            ? (str(a["path"]) ?? str(a["command"]) ?? str(a["filePath"]) ?? "")
            : "";
          return {
            type: "tool.use",
            msg: detail ? `${name} ${detail}` : name,
            data: { name, arguments: d["arguments"] },
          };
        }
        case "tool.execution_complete": {
          const ok = d["success"] !== false;
          const err = obj(d["error"]);
          return {
            type: ok ? "tool.result" : "run.error",
            msg: ok ? "tool ok" : (str(err?.["message"]) ?? "tool failed"),
            data: { success: ok, error: d["error"] },
          };
        }
        case "assistant.message":
        case "assistant.response":
        case "assistant.message_complete": {
          const text = digText(d);
          return text?.trim() ? { type: "agent.text", msg: text } : null;
        }
        default:
          break;
      }
    }

    const type = (t ?? str(j["event"]) ?? "").toLowerCase();

    if (type.includes("tool") && (type.includes("call") || type.includes("use") || type.includes("start"))) {
      return {
        type: "tool.use",
        msg: str(j["name"]) ?? str(j["tool"]) ?? digText(j) ?? "tool",
        data: j,
      };
    }
    if (type.includes("tool") && (type.includes("result") || type.includes("end") || type.includes("complete"))) {
      return { type: "tool.result", msg: str(j["name"]) ?? "tool result", data: j };
    }
    if (type.includes("reason") || type.includes("thinking")) {
      return { type: "agent.reasoning", msg: digText(j) ?? "" };
    }
    if (type.includes("error") || j["error"] !== undefined) {
      return { type: "run.error", msg: digText(j["error"]) ?? digText(j) ?? "error", data: j };
    }
    if (type.includes("permission") || type.includes("approval") || type.includes("confirm")) {
      return { type: "permission.request", msg: digText(j) ?? "permission", data: j };
    }
    if (type === "done" || type.includes("session_end") || type.includes("finish")) {
      return { type: "run.end", msg: digText(j) ?? "done", data: j };
    }

    // Assistant text arrives under several key names depending on version.
    const content = arr(j["content"]);
    if (content) {
      for (const block of content) {
        const b = obj(block);
        if (b?.["type"] === "text") {
          const t = str(b["text"]);
          if (t?.trim()) return { type: "agent.text", msg: t };
        }
      }
    }
    const text = digText(j);
    if (text?.trim() && (type.includes("message") || type.includes("assistant") || type === "")) {
      return { type: "agent.text", msg: text };
    }
    return null;
  },

  detectExhaustion(text, exitCode) {
    // Copilot's premium-request budget is monthly; a long cooldown avoids
    // hammering it, and `fleet status --clear` overrides when you top up.
    return detectExhaustionGeneric(text, exitCode, 60 * 60_000);
  },
};
