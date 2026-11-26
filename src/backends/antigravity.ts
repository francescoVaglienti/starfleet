import type { Backend, FleetEvent, RunOptions } from "../types.js";
import { obj, safeJson, str, which, detectExhaustionGeneric, parseRetryAfter } from "./common.js";

type Parsed = Pick<FleetEvent, "type" | "msg" | "data"> | null;

/**
 * Antigravity is Google's agent suite; `agy` is its headless CLI and Fleet's
 * backend for Gemini models.
 *
 * Its stream-json is a tagged union: every line is {event, [event]: {...}}.
 * Nearly all of it arrives as `step_update`, discriminated by `step_type` and
 * `state`, with assistant prose in `text_delta` — hence `streamsTextDeltas`.
 */
export const antigravityBackend: Backend = {
  id: "antigravity",
  displayName: "Antigravity",
  bin: "agy",
  streamsTextDeltas: true,

  resolveBin() {
    return which("agy");
  },

  buildArgs(o: RunOptions): string[] {
    const args = [
      `--print=${o.prompt}`,
      "--output-format", "stream-json", "--print-timeout", "24h",
    ];
    if (o.readOnly) args.push("--mode", "plan", "--disable-slash-commands");
    else args.push("--dangerously-skip-permissions");
    if (o.model) args.push("--model", o.model);
    if (o.effort) args.push("--effort", o.effort);
    if (!o.readOnly) for (const d of o.extraDirs ?? []) args.push("--add-dir", d);
    return args;
  },

  parseLine(line: string): Parsed {
    const j = safeJson(line);
    if (!j) return null;
    const event = str(j["event"]);
    if (!event) return null;
    const b = obj(j[event]) ?? {};

    if (event === "init") {
      // A second run.start beside the dispatcher's. The dispatcher's records
      // what we asked for; this one records what agy resolved, including the
      // permission mode actually in force.
      return {
        type: "run.start",
        msg: `agy ${str(b["model"]) ?? "?"} · ${str(b["permission_mode"]) ?? "?"}`,
        data: { model: b["model"], cwd: b["cwd"], permission_mode: b["permission_mode"] },
      };
    }

    if (event === "result") {
      const ok = str(b["status"]) === "SUCCESS";
      const u = obj(b["usage"]) ?? {};
      // NOT run.end on success: the runner emits its own terminal event when the
      // process closes, and a second one would fire the desktop notification
      // twice for every run. The stats still belong in the log, so they ride the
      // reasoning channel, which is neither terminal nor notifying.
      return {
        type: ok ? "agent.reasoning" : "run.error",
        msg: ok
          ? `agy done · ${String(u["total_tokens"] ?? "?")} tokens · ${String(b["num_turns"] ?? "?")} turn(s)`
          : `result ${str(b["status"]) ?? "unknown"}`,
        data: {
          status: b["status"],
          usage: b["usage"],
          num_turns: b["num_turns"],
          conversation_id: b["conversation_id"],
        },
      };
    }

    if (event !== "step_update") return null;

    const state = str(b["state"]);
    const stepType = str(b["step_type"]);

    if (stepType === "tool") {
      const info = obj(b["tool_info"]) ?? {};
      const name = str(b["tool_name"]) ?? str(info["name"]) ?? "tool";
      if (state === "ACTIVE") {
        const p = obj(info["parameters"]);
        // agy's parameter names are PascalCase and vary per tool.
        const detail = p
          ? (str(p["CommandLine"]) ??
            str(p["AbsolutePath"]) ??
            str(p["TargetFile"]) ??
            str(p["DirectoryPath"]) ??
            str(p["Query"]) ??
            "")
          : "";
        return {
          type: "tool.use",
          msg: detail ? `${name} ${detail}` : name,
          data: { name, parameters: info["parameters"] },
        };
      }
      const err = obj(info["error"]);
      // A denied or failed tool is not a failed run — the agent reads the
      // error and carries on, so this must not raise run.error.
      return {
        type: "tool.result",
        msg:
          state === "ERROR"
            ? `tool failed: ${str(err?.["message"])?.split("\n")[0] ?? "unknown error"}`
            : "tool ok",
        data: {
          name,
          state,
          error: info["error"],
          output: str(info["output"])?.slice(0, 2_000),
        },
      };
    }

    if (stepType === "agent_response") {
      // Most agent_response steps are planning turns carrying only usage
      // numbers; only the visible answer carries text.
      const delta = str(b["text_delta"]);
      return delta ? { type: "agent.text", msg: delta } : null;
    }

    // user_input, checkpoint, unknown — bookkeeping with nothing to report.
    return null;
  },

  detectFailure(text) {
    // agy exits 0 even when every tool was denied and it produced nothing, and
    // even when its own result says the run did not succeed. Believing the exit
    // code alone would write a "done" handoff onto the ledger for a run that
    // did nothing at all.
    // Against diagnostics only. Matching the raw stream would fire whenever an
    // agent happens to run `agy` itself and quote it back — which is exactly how
    // this bug was caught, on the review run for this backend.
    if (/no output produced/i.test(diagnosticsOnly(text))) {
      return "agy produced no output — every tool call was denied";
    }
    for (const line of text.split("\n").reverse()) {
      const j = safeJson(line);
      if (str(j?.["event"]) !== "result") continue;
      const b = obj(j?.["result"]) ?? {};
      const status = str(b["status"]);
      return status === "SUCCESS" ? null : `agy result status ${status ?? "unknown"}`;
    }
    return null;
  },

  detectExhaustion(text, exitCode) {
    // Deliberately NOT gated on a non-zero exit, unlike the other backends: agy
    // catches API errors, reports them in its result and still exits 0, so
    // gating here would mean a spent quota never triggers a failover. Scoping
    // the patterns to diagnostics is what makes that safe.
    const tail = diagnosticsOnly(text).slice(-8_000);

    // UNVERIFIED: no run has hit a real Gemini limit yet, so these are guesses
    // at Google's wording. When one does, read the true message out of
    // ~/.fleet/logs/ and replace these rather than adding more guesses.
    const spent = tail.match(/RESOURCE_EXHAUSTED|daily (?:usage )?limit|limit will reset|out of credits/i);
    if (spent) {
      return {
        kind: "quota",
        // Gemini's Pro allowance is daily, so absent an explicit reset time a
        // short retry would just burn the failover chain again.
        retryAfterMs: parseRetryAfter(tail) ?? 6 * 3_600_000,
        detail: tail
          .slice(Math.max(0, (spent.index ?? 0) - 200), (spent.index ?? 0) + 300)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 300),
      };
    }

    // UNAUTHENTICATED is the gRPC status agy surfaces on an expired token.
    const ineligible = tail.match(
      /UNAUTHENTICATED|not (?:signed|logged) in|please (?:sign|log) in|IneligibleTier|UNSUPPORTED_CLIENT/i,
    );
    if (ineligible) {
      return {
        kind: "auth",
        // Only a human re-login clears this; a timer never will.
        retryAfterMs: 12 * 3_600_000,
        detail: `Antigravity rejected this session — run \`agy\` and sign in. ${tail
          .slice(ineligible.index ?? 0, (ineligible.index ?? 0) + 200)
          .replace(/\s+/g, " ")
          .trim()}`.slice(0, 300),
      };
    }

    // The generic helper believes a zero exit, so only consult it when the exit
    // code carries information.
    return exitCode === 0 ? null : detectExhaustionGeneric(diagnosticsOnly(text), exitCode, 60 * 60_000);
  },
};

/**
 * Keep backend diagnostics, excluding generated responses and tool output.
 */
function diagnosticsOnly(text: string): string {
  const lines = text.split("\n");
  return lines.flatMap((line, index) => {
      const j = safeJson(line);
      if (!j) {
        const trimmed = line.trim();
        if (index === 0 && lines.length > 1 && (trimmed.startsWith("{") || /[}\]]$/.test(trimmed))) return [];
        return [line];
      }
      if (str(j["event"]) !== "result") return [];
      const result = obj(j["result"]) ?? {};
      const { response: _response, usage: _usage, ...diagnostics } = result;
      return [JSON.stringify(diagnostics)];
    })
    .join("\n");
}
