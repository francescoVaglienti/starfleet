import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadPolicy, projectFor } from "./policy.js";
import { configureNotify, readEvents } from "./events.js";
import { loadHealth, cooldownRemaining, clearCooldown } from "./health.js";
import { BACKENDS, installedBackends } from "./backends/index.js";
import {
  appendHandoff,
  createLedger,
  listLedgers,
  readLedger,
  updateSection,
  writeLedger,
} from "./ledger.js";
import { dispatch, resolveChain } from "./run.js";
import { ensureWorktrees, slugify, dirtyFiles, listWorktrees } from "./worktree.js";
import { BACKEND_IDS, ROLES, type BackendId, type Role } from "./types.js";
import { runCompletionGate } from "./vibemin.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export const MCP_VERSION = "0.2.0";
export const MCP_TOOL_NAMES = [
  "fleet_status",
  "fleet_task_new",
  "fleet_delegate",
  "fleet_checkpoint",
  "fleet_task_done",
  "fleet_ledger_read",
  "fleet_events",
  "fleet_route_preview",
  "fleet_clear_cooldown",
  "fleet_worktrees",
] as const;
export const IMPORTANT_EVENT_TYPES = [
  "run.start",
  "run.end",
  "run.error",
  "exhausted",
  "failover",
  "permission.request",
  "vibemin.start",
  "vibemin.end",
  "vibemin.error",
] as const;

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: "fleet", version: MCP_VERSION });
  const policy = loadPolicy();
  configureNotify(policy.notify);

  server.tool(
    MCP_TOOL_NAMES[0],
    "Show backend health, cooldowns, models, routing, and active Fleet tasks. " +
      "Call this before delegating so you route to a backend that is actually up.",
    {},
    async () => {
      const health = loadHealth();
      const installed = installedBackends();
      const lines = BACKEND_IDS.map((id) => {
        if (!installed.includes(id)) return `  ${id.padEnd(8)} not installed`;
        const h = health[id];
        const cd = cooldownRemaining(id);
        if (cd > 0) {
          return `  ${id.padEnd(8)} COOLDOWN ${Math.ceil(cd / 60_000)}m — ${h?.reason ?? "unknown"}`;
        }
        const version = BACKENDS[id].version?.();
        const preference = policy.models[id];
        const model = preference?.model ?? "backend default";
        const resolved = h?.lastResolvedModel ? ` · last resolved ${h.lastResolvedModel}` : "";
        const effort = preference?.effort ? `/${preference.effort}` : "";
        return `  ${id.padEnd(12)} ok · ${model}${effort}${resolved}${version ? ` · v${version}` : ""}${h?.lastRunAt ? ` (last run ${h.lastRunAt})` : ""}`;
      });
      const routing = ROLES.map(
        (role) => `  ${role.padEnd(12)} ${policy.routing[role].join(" → ")}`,
      );
      const tasks = listLedgers().map(
        (l) =>
          `  ${l.meta.id.padEnd(24)} ${l.meta.status.padEnd(12)} ${
            l.meta.worktrees?.map((w) => w.branch).join(", ") ?? "no worktree"
          }`,
      );
      return text(
        `BACKENDS\n${lines.join("\n")}\n\nROUTING\n${routing.join("\n")}\n\nTASKS\n${tasks.length ? tasks.join("\n") : "  (none)"}`,
      );
    },
  );

  server.tool(
    MCP_TOOL_NAMES[1],
    "Create a new fleet task: writes a durable ledger file and creates an isolated git worktree " +
      "on a correctly-named branch. Use this to start any unit of work worth tracking — one task " +
      "per feature, so each feature has its own branch and worktree.",
    {
      id: z.string().describe("Short kebab-case task id, e.g. 'upload-modal-cleanup'"),
      title: z.string().describe("Human-readable task title"),
      project: z.string().describe("Absolute path to the repo or multi-repo parent folder"),
      ticket: z.string().optional().describe("Ticket/issue number, if the project's convention needs one"),
      kind: z.string().optional().describe("Branch kind segment: task | fix | feature | chore"),
      repos: z
        .array(z.string())
        .optional()
        .describe("For multi-repo projects, the subset of repos this task spans"),
      base: z
        .string()
        .optional()
        .describe(
          "Branch from this ref instead of the project default. Pass it when the task " +
            "builds on commits that are not on the default branch yet, otherwise the " +
            "worktree silently lacks them.",
        ),
    },
    async ({ id, title, project, ticket, kind, repos, base }) => {
      if (readLedger(id)) return text(`Task "${id}" already exists. Use fleet_ledger_read.`);
      const l = createLedger({ id, title, repo: project });
      const slug = slugify(title);
      let created = "";
      try {
        const wts = ensureWorktrees({
          policy,
          projectKey: project,
          taskId: id,
          spec: { kind, ticket, slug },
          repos,
          base,
        });
        l.meta.worktrees = wts;
        l.meta.ticket = ticket;
        l.meta.kind = kind;
        l.meta.status = "in_progress";
        writeLedger(l);
        created = wts.map((w) => `  ${w.branch}\n    ${w.path}  (from ${w.base})`).join("\n");
      } catch (e) {
        return text(
          `Ledger created at ${l.path}, but worktree setup failed:\n${(e as Error).message}`,
        );
      }
      return text(`Task "${id}" created.\nLedger: ${l.path}\nWorktrees:\n${created}`);
    },
  );

  server.tool(
    MCP_TOOL_NAMES[2],
    "Hand a unit of work to another coding agent running in this task's " +
      "isolated worktree. Use this to parallelise, to get an independent second opinion from a " +
      "different model family, or to offload long mechanical work. The other agent reads the " +
      "task ledger for context, so make sure the ledger is current first (fleet_checkpoint).",
    {
      taskId: z.string().describe("Existing fleet task id"),
      instruction: z.string().describe("What the delegated agent should do. Be specific and self-contained."),
      role: z
        .enum(ROLES as [Role, ...Role[]])
        .default("implement")
        .describe("manage | implement | review | chore — selects the backend preference chain"),
      backend: z
        .enum(BACKEND_IDS as [BackendId, ...BackendId[]])
        .optional()
        .describe("Force a specific backend instead of the role's chain"),
      readOnly: z.boolean().default(false).describe("Run without write access (use for review)"),
      wait: z
        .boolean()
        .default(true)
        .describe("Block until the agent finishes. Set false for long runs, then poll fleet_events."),
      timeoutMinutes: z.number().default(20).describe("Idle timeout in minutes: the run is killed only after this long with no output (hard ceiling 8 h)"),
    },
    async ({ taskId, instruction, role, backend, readOnly, wait, timeoutMinutes }) => {
      const l = readLedger(taskId);
      if (!l) return text(`No such task "${taskId}". Create it with fleet_task_new.`);

      if (!wait) {
        const bin = join(HERE, "..", "bin", "fleet");
        const args = ["run", taskId, "--role", role, "--prompt", instruction, "--timeout", String(timeoutMinutes)];
        if (backend) args.push("--backend", backend);
        if (readOnly) args.push("--read-only");
        const child = spawn(bin, args, { detached: true, stdio: "ignore" });
        child.unref();
        return text(
          `Started ${backend ?? role} run on "${taskId}" in the background.\n` +
            `Poll with fleet_events(taskId: "${taskId}").`,
        );
      }

      const { result, attempts } = await dispatch({
        taskId,
        task: instruction,
        role,
        policy,
        backend,
        readOnly,
        timeoutMs: timeoutMinutes * 60_000,
      });

      const trail = attempts
        .map((a) => `  ${a.backend}: ${a.outcome}${a.detail ? ` (${a.detail})` : ""}`)
        .join("\n");

      if (!result) {
        return text(`No backend could take this run.\n${trail}`);
      }
      const after = readLedger(taskId);
      return text(
        `Ran on ${result.backend} — exit ${String(result.exitCode)} in ${Math.round(
          result.durationMs / 1000,
        )}s\n\nRouting:\n${trail}\n\nAgent's final message:\n${
          result.finalMessage.slice(0, 4000) || "(none captured)"
        }\n\nLedger "Current state" is now:\n${sectionOf(after?.body ?? "", "Current state")}`,
      );
    },
  );

  server.tool(
    MCP_TOOL_NAMES[3],
    "Update the task ledger so another agent could continue cold. Call this whenever you finish " +
      "a meaningful increment — and ALWAYS before you risk running out of context. The ledger is " +
      "the only thing that survives you.",
    {
      taskId: z.string(),
      state: z.string().optional().describe("Overwrites 'Current state' — what is true right now"),
      next: z.string().optional().describe("Overwrites 'Next' — the ordered queue of remaining work"),
      landmine: z.string().optional().describe("Appended to 'Landmines' — something that broke, so nobody repeats it"),
      question: z.string().optional().describe("Appended to 'Open questions' — needs a human decision"),
      handoff: z.string().optional().describe("Appended to 'Handoffs' — one line on what you just did"),
      status: z.enum(["todo", "in_progress", "blocked"]).optional(),
    },
    async ({ taskId, state, next, landmine, question, handoff, status }) => {
      const l = readLedger(taskId);
      if (!l) return text(`No such task "${taskId}".`);
      const done: string[] = [];
      if (state) (updateSection(taskId, "Current state", state), done.push("state"));
      if (next) (updateSection(taskId, "Next", next), done.push("next"));
      if (landmine) {
        const cur = readLedger(taskId);
        updateSection(taskId, "Landmines", `${sectionOf(cur?.body ?? "", "Landmines")}\n- ${landmine}`.trim());
        done.push("landmine");
      }
      if (question) {
        const cur = readLedger(taskId);
        updateSection(
          taskId,
          "Open questions",
          `${sectionOf(cur?.body ?? "", "Open questions")}\n- ${question}`.trim(),
        );
        done.push("question");
      }
      if (handoff) (appendHandoff(taskId, `manager — ${handoff}`), done.push("handoff"));
      if (status) {
        const cur = readLedger(taskId);
        if (cur) {
          cur.meta.status = status;
          writeLedger(cur);
          done.push(`status=${status}`);
        }
      }
      return text(`Ledger "${taskId}" updated: ${done.join(", ") || "nothing"}.`);
    },
  );

  server.tool(
    MCP_TOOL_NAMES[4],
    "Run the mandatory Vibemin completion gate in every worktree, then mark the task done only when it passes.",
    { taskId: z.string() },
    async ({ taskId }) => {
      const l = readLedger(taskId);
      if (!l) return text(`No such task "${taskId}".`);
      const gate = runCompletionGate(policy, l);
      if (!gate.ok) return text(`Completion refused: ${gate.reason}`);
      const current = readLedger(taskId);
      if (current) {
        current.meta.status = "done";
        writeLedger(current);
      }
      appendHandoff(taskId, "marked done after mandatory Vibemin gate");
      return text(`Task "${taskId}" passed Vibemin and is done.`);
    },
  );

  server.tool(
    MCP_TOOL_NAMES[5],
    "Read a task's full ledger — intent, current state, queue, landmines, handoff history. " +
      "Read this before working on a task you did not start.",
    { taskId: z.string() },
    async ({ taskId }) => {
      const l = readLedger(taskId);
      if (!l) {
        const all = listLedgers().map((x) => x.meta.id);
        return text(`No such task "${taskId}".\nKnown tasks: ${all.join(", ") || "(none)"}`);
      }
      const wt = (l.meta.worktrees ?? [])
        .map((w) => {
          const d = dirtyFiles(w.path);
          return `  ${w.branch} @ ${w.path}${d.length ? ` — ${d.length} uncommitted file(s)` : " — clean"}`;
        })
        .join("\n");
      return text(`# ${l.meta.title}\nstatus: ${l.meta.status}\nworktrees:\n${wt || "  (none)"}\n\n${l.body}`);
    },
  );

  server.tool(
    MCP_TOOL_NAMES[6],
    "Recent activity from any agent on a task — the shared audit log. Use to check on a " +
      "background delegation, or to see what another agent did.",
    {
      taskId: z.string().optional(),
      limit: z.number().default(40),
      onlyImportant: z
        .boolean()
        .default(true)
        .describe("Filter out per-tool chatter, keeping starts, ends, errors and failovers"),
    },
    async ({ taskId, limit, onlyImportant }) => {
      const evs = await readEvents({
        taskId,
        limit,
        types: onlyImportant
          ? [...IMPORTANT_EVENT_TYPES]
          : undefined,
      });
      if (!evs.length) return text("No events.");
      return text(
        evs
          .map((e) => `${e.ts.slice(11, 19)} ${e.backend.padEnd(7)} ${e.type.padEnd(16)} ${(e.msg ?? "").slice(0, 160)}`)
          .join("\n"),
      );
    },
  );

  server.tool(
    MCP_TOOL_NAMES[7],
    "Show which backend a delegation would actually land on for a given role, and why the " +
      "others were skipped. Use when you are unsure whether a backend is up.",
    {
      role: z.enum(ROLES as [Role, ...Role[]]),
      taskId: z.string().optional(),
      project: z.string().optional(),
    },
    async ({ role, taskId, project }) => {
      const l = taskId ? readLedger(taskId) : null;
      const { chain, skipped } = resolveChain({ policy, role, ledger: l, project });
      return text(
        `role "${role}"\n  would use: ${chain[0] ?? "NOTHING AVAILABLE"}\n` +
          `  fallback order: ${chain.join(" -> ") || "(none)"}\n` +
          `  skipped: ${skipped.map((s) => `${s.backend} (${s.reason})`).join(", ") || "none"}`,
      );
    },
  );

  server.tool(
    MCP_TOOL_NAMES[8],
    "Clear a backend's cooldown after its limit has reset or you have topped up credits.",
    { backend: z.enum(BACKEND_IDS as [BackendId, ...BackendId[]]) },
    async ({ backend }) => {
      clearCooldown(backend);
      return text(`Cooldown cleared for ${backend}.`);
    },
  );

  server.tool(
    MCP_TOOL_NAMES[9],
    "List every worktree fleet knows about for a project, with branch and dirty state — " +
      "so you can see what happened where.",
    { project: z.string().describe("Absolute path to a repo or multi-repo parent folder") },
    async ({ project }) => {
      const cfg = projectFor(policy, project);
      const repos = cfg.repos?.length
        ? cfg.repos.map((r) => (r.startsWith("/") ? r : join(project, r)))
        : [project];
      const out = repos.map((r) => {
        const wts = listWorktrees(r);
        const rows = wts.map((w) => {
          const d = dirtyFiles(w.path);
          return `    ${w.branch.padEnd(42)} ${d.length ? `${d.length} dirty` : "clean"}  ${w.path}`;
        });
        return `  ${r}\n${rows.join("\n") || "    (none)"}`;
      });
      return text(out.join("\n\n"));
    },
  );

  await server.connect(new StdioServerTransport());
}

function sectionOf(body: string, name: string): string {
  const re = new RegExp(`^##[ \\t]+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$([\\s\\S]*?)(?=^##[ \\t]+|(?![\\s\\S]))`, "m");
  const m = body.match(re);
  return (m?.[1] ?? "").trim();
}
