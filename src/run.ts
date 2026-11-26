import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getBackend } from "./backends/index.js";
import { emit } from "./events.js";
import { isAvailable, markExhausted, markFailure, markSuccess, cooldownRemaining, recordResolvedModel } from "./health.js";
import { runLogPath, P } from "./paths.js";
import { appendHandoff, composePrompt, readLedger } from "./ledger.js";
import { acquireLock, releaseLock } from "./worktree.js";
import { applicationStackFor, modelFor, routingFor } from "./policy.js";
import type {
  BackendId,
  Policy,
  Role,
  RunOptions,
  RunResult,
  Ledger,
} from "./types.js";

export interface DispatchOpts {
  taskId: string;
  task: string;
  role: Role;
  policy: Policy;
  /** Force a specific backend, skipping the routing chain. */
  backend?: BackendId;
  /** Explicit cwd override; otherwise the task's first worktree. */
  cwd?: string;
  readOnly?: boolean;
  /** Stream normalised events to the terminal as they arrive. */
  onEvent?: (type: string, msg: string, backend: BackendId) => void;
  timeoutMs?: number;
}

export interface DispatchResult {
  result: RunResult | null;
  attempts: Array<{ backend: BackendId; outcome: string; detail?: string }>;
}

/** Ordered, filtered backend chain for a role. */
export function resolveChain(opts: {
  policy: Policy;
  role: Role;
  ledger?: Ledger | null;
  project?: string;
  force?: BackendId;
}): { chain: BackendId[]; skipped: Array<{ backend: BackendId; reason: string }> } {
  if (opts.force) return { chain: [opts.force], skipped: [] };
  const fromLedger = opts.ledger?.meta.routing?.[opts.role];
  const raw = fromLedger ?? routingFor(
    opts.policy,
    opts.ledger?.meta.repo ?? opts.project ?? process.cwd(),
    opts.role,
  );

  const chain: BackendId[] = [];
  const skipped: Array<{ backend: BackendId; reason: string }> = [];
  for (const id of raw) {
    const b = getBackend(id);
    if (!b?.resolveBin()) {
      skipped.push({ backend: id, reason: "not installed" });
      continue;
    }
    if (!isAvailable(id)) {
      const mins = Math.ceil(cooldownRemaining(id) / 60_000);
      skipped.push({ backend: id, reason: `cooling down ${mins}m` });
      continue;
    }
    chain.push(id);
  }
  return { chain, skipped };
}

/**
 * Run a task against the first healthy backend in the chain, falling through
 * to the next when one reports it is out of capacity.
 */
export async function dispatch(opts: DispatchOpts): Promise<DispatchResult> {
  const ledger = readLedger(opts.taskId);
  if (!ledger) throw new Error(`No ledger for task "${opts.taskId}". Run: fleet task new ${opts.taskId}`);

  const cwd = opts.cwd ?? ledger.meta.worktrees?.[0]?.path ?? ledger.meta.repo;
  // The ledger dir must be writable by every backend — it IS the handoff. Codex's
  // workspace-write sandbox and Copilot's path verification both scope to cwd, so
  // without this an agent silently fails to check out at the end of its run.
  const extraDirs = [
    ...(ledger.meta.worktrees ?? []).map((w) => w.path).filter((p) => p !== cwd),
    P.ledgerDir,
  ];

  const { chain, skipped } = resolveChain({
    policy: opts.policy,
    role: opts.role,
    ledger,
    force: opts.backend,
  });

  const attempts: DispatchResult["attempts"] = skipped.map((s) => ({
    backend: s.backend,
    outcome: "skipped",
    detail: s.reason,
  }));

  if (chain.length === 0) {
    emit({
      runId: "-",
      taskId: opts.taskId,
      backend: "fleet",
      type: "run.error",
      msg: "no backend available",
      data: { skipped },
    });
    return { result: null, attempts };
  }

  for (const id of chain) {
    const runId = randomUUID().slice(0, 8);
    const prompt = composePrompt(
      ledger,
      opts.task,
      opts.role,
      applicationStackFor(opts.policy, ledger.meta.repo),
    );

    const held = acquireLock(cwd, { backend: id, runId, taskId: opts.taskId, pid: process.pid });
    if (held) {
      attempts.push({
        backend: id,
        outcome: "blocked",
        detail: `worktree locked by ${held.backend} (run ${held.runId}, pid ${held.pid})`,
      });
      // A locked worktree is a coordination problem, not a capacity one —
      // trying another backend on the same directory would only collide too.
      break;
    }

    try {
      const preference = modelFor(opts.policy, ledger.meta.repo, id);
      const res = await runOne(id, {
        taskId: opts.taskId,
        runId,
        prompt,
        cwd,
        model: preference.model,
        effort: preference.effort,
        readOnly: opts.readOnly || (id === "pi" && opts.role === "review"),
        extraDirs,
      }, opts.onEvent, opts.timeoutMs);

      if (res.exhaustion) {
        markExhausted(id, res.exhaustion);
        emit({
          runId,
          taskId: opts.taskId,
          backend: id,
          type: "exhausted",
          msg: `${res.exhaustion.kind}: ${res.exhaustion.detail}`,
          data: { retryAfterMs: res.exhaustion.retryAfterMs },
        });
        attempts.push({ backend: id, outcome: "exhausted", detail: res.exhaustion.kind });
        const next = chain[chain.indexOf(id) + 1];
        if (next) {
          emit({
            runId,
            taskId: opts.taskId,
            backend: "fleet",
            type: "failover",
            msg: `${id} exhausted -> handing off to ${next}`,
          });
        }
        continue;
      }

      if (res.exitCode === 0 && !res.failureReason) {
        markSuccess(id, res.exitCode);
        attempts.push({ backend: id, outcome: "ok" });
        // Carry the agent's closing message onto the ledger. A --read-only
        // agent cannot write the ledger by definition, so a review's
        // findings would otherwise live only in the terminal that ran it.
        // The ledger is the handoff mechanism; it must not depend on the
        // agent both being able to write it and remembering to.
        appendHandoff(
          opts.taskId,
          `${id} (${opts.role}) run ${runId} — exit 0 in ${Math.round(res.durationMs / 1000)}s` +
            (res.finalMessage.trim() ? `\n\n${res.finalMessage.trim()}` : ""),
        );
        return { result: res, attempts };
      }

      markFailure(id, res.exitCode, opts.policy.cooldown.failureMinutes);
      const why = res.failureReason ?? `exit ${String(res.exitCode)}`;
      attempts.push({ backend: id, outcome: "failed", detail: why });
      appendHandoff(opts.taskId, `${id} (${opts.role}) run ${runId} — FAILED: ${why}`);
      // A non-zero exit that is not an exhaustion is usually the task's fault.
      // Retrying it on another vendor tends to burn a second budget for the
      // same error, so we stop and surface it instead.
      return { result: res, attempts };
    } finally {
      releaseLock(cwd);
    }
  }

  return { result: null, attempts };
}

/** Spawn one backend and normalise its output stream into the event bus. */
export function runOne(
  id: BackendId,
  o: RunOptions,
  onEvent?: DispatchOpts["onEvent"],
  timeoutMs?: number,
): Promise<RunResult> {
  const backend = getBackend(id);
  const bin = backend.resolveBin();
  if (!bin) throw new Error(`${backend.displayName} is not installed`);

  const logPath = runLogPath(o.taskId, o.runId);
  const args = backend.buildArgs(o);
  const environment = { ...process.env, ...(backend.env?.(o) ?? {}), FLEET_TASK: o.taskId, FLEET_RUN: o.runId };
  const started = Date.now();

  emit(
    {
      runId: o.runId,
      taskId: o.taskId,
      backend: id,
      type: "run.start",
      msg: `${backend.displayName} in ${o.cwd}`,
      data: { cwd: o.cwd, model: o.model, effort: o.effort, readOnly: o.readOnly ?? false },
    },
    logPath,
  );

  return new Promise<RunResult>((resolve) => {
    const child = spawn(bin, args, {
      cwd: o.cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";
    let stdoutTail = "";
    let finalMessage = "";
    let resolvedModel = "";
    let timedOut = false;

    // The timeout is an IDLE timeout: it re-arms on every line the backend writes.
    // A deep task that keeps working is never killed for taking long; only a run
    // that has gone silent for `timeoutMs` is. A hard ceiling of 8 hours stops a
    // runaway that keeps emitting.
    const HARD_CEILING_MS = 8 * 60 * 60_000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const killForTimeout = () => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    };
    const armTimer = () => {
      if (!timeoutMs) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(killForTimeout, timeoutMs);
    };
    armTimer();
    const ceiling = timeoutMs ? setTimeout(killForTimeout, HARD_CEILING_MS) : null;
    if (ceiling) ceiling.unref();

    // Delta-streaming backends emit assistant text one chunk at a
    // time with no completion event. Buffer the chunks and publish each
    // contiguous run of them as a single agent.text, so the log reads the same
    // for every vendor and one event per token never reaches events.jsonl.
    let textBuf = "";
    const flushText = () => {
      const text = textBuf;
      textBuf = "";
      if (!text.trim()) return;
      finalMessage = text;
      emit(
        { runId: o.runId, taskId: o.taskId, backend: id, type: "agent.text", msg: text },
        logPath,
      );
      onEvent?.("agent.text", text, id);
    };

    const consumeLine = (line: string) => {
      armTimer();
      const diagnostic = backend.diagnosticLine ? backend.diagnosticLine(line) : line;
      if (diagnostic !== null) stdoutTail = (stdoutTail + diagnostic + "\n").slice(-16_000);
      const parsed = backend.parseLine(line);
      if (!parsed) return;
      if (id === "pi" && parsed.data && typeof parsed.data === "object") {
        const message = parsed.data as Record<string, unknown>;
        if (message.role === "assistant" && typeof message.provider === "string" && message.provider &&
            typeof message.model === "string" && message.model) {
          const model = `${message.provider}/${message.model}`;
          if (model !== resolvedModel) {
            recordResolvedModel(id, model);
            resolvedModel = model;
          }
        }
      }
      if (backend.streamsTextDeltas) {
        if (parsed.type === "agent.text") {
          textBuf += parsed.msg ?? "";
          return;
        }
        // Anything else closes the assistant's current block, so the run's
        // closing message is its last contiguous block of prose. When a run
        // ends on a tool call with nothing said afterwards that is text from
        // before the call — deliberately, since a slightly stale summary on the
        // ledger beats an empty one.
        flushText();
      } else if (parsed.type === "agent.text" && parsed.msg) {
        finalMessage = parsed.msg;
      }
      emit(
        {
          runId: o.runId,
          taskId: o.taskId,
          backend: id,
          type: parsed.type,
          msg: parsed.msg,
          data: parsed.data,
        },
        logPath,
      );
      onEvent?.(parsed.type, parsed.msg ?? "", id);
    };
    let stdoutBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline: number;
      while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
        consumeLine(stdoutBuffer.slice(0, newline).replace(/\r$/, ""));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
      }
    });
    child.stdout.on("end", () => {
      if (stdoutBuffer) consumeLine(stdoutBuffer);
    });

    child.stderr.on("data", (d: Buffer) => {
      stderrBuf = (stderrBuf + d.toString()).slice(-16_000);
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (ceiling) clearTimeout(ceiling);
      emit(
        { runId: o.runId, taskId: o.taskId, backend: id, type: "run.error", msg: err.message },
        logPath,
      );
      resolve({
        backend: id,
        runId: o.runId,
        exitCode: null,
        finalMessage: "",
        durationMs: Date.now() - started,
        exhaustion: null,
        logPath,
      });
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (ceiling) clearTimeout(ceiling);
      // A backend killed mid-stream still owes us whatever it had said.
      flushText();
      const combined = `${stdoutTail}\n${stderrBuf}`;
      const exhaustion = timedOut ? null : backend.detectExhaustion(combined, code);
      // A backend that reports its own failure but still exits 0 must not be
      // recorded as a success — that would put a "done" handoff on the ledger.
      const failureReason =
        timedOut || code !== 0 ? undefined : (backend.detectFailure?.(combined, code) ?? undefined);

      emit(
        {
          runId: o.runId,
          taskId: o.taskId,
          backend: id,
          type: code === 0 && !failureReason ? "run.end" : "run.error",
          msg: timedOut
            ? "timed out"
            : failureReason
              ? `reported failure despite exit 0: ${failureReason}`
              : code === 0
              ? `completed in ${Math.round((Date.now() - started) / 1000)}s`
              : `exit ${String(code)}: ${stderrBuf.slice(-400).trim()}`,
          data: { exitCode: code, durationMs: Date.now() - started, timedOut },
        },
        logPath,
      );

      resolve({
        backend: id,
        runId: o.runId,
        exitCode: code,
        failureReason,
        finalMessage,
        durationMs: Date.now() - started,
        exhaustion,
        logPath,
      });
    });
  });
}
