import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import YAML from "yaml";
import { ledgerPath, ensureDirs, P } from "./paths.js";
import { TASK_STATUSES, type Ledger, type LedgerMeta, type BackendId, type TaskStatus } from "./types.js";
import { directivesFor } from "./directives.js";

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function ledgerExists(id: string): boolean {
  return existsSync(ledgerPath(id));
}

export function listLedgers(): Ledger[] {
  ensureDirs();
  return readdirSync(P.ledgerDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readLedger(basename(f, ".md")))
    .filter((l): l is Ledger => l !== null)
    .sort((a, b) => b.meta.updated.localeCompare(a.meta.updated));
}

export function readLedger(id: string): Ledger | null {
  const path = ledgerPath(id);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const m = raw.match(FM);
  if (!m?.[1]) {
    return {
      path,
      body: raw,
      meta: {
        id,
        title: id,
        status: "in_progress",
        repo: process.cwd(),
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      },
    };
  }
  const meta = (YAML.parse(m[1]) ?? {}) as Partial<LedgerMeta>;
  return {
    path,
    body: raw.slice(m[0].length),
    meta: {
      id: meta.id ?? id,
      title: meta.title ?? id,
      status: taskStatus(meta.status),
      repo: meta.repo ?? process.cwd(),
      created: meta.created ?? new Date().toISOString(),
      updated: meta.updated ?? new Date().toISOString(),
      ticket: meta.ticket,
      kind: meta.kind,
      worktrees: meta.worktrees,
      removedWorktrees: meta.removedWorktrees,
      routing: meta.routing,
    },
  };
}

function taskStatus(value: unknown): TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value)
    ? (value as TaskStatus)
    : "in_progress";
}

export function writeLedger(l: Ledger): void {
  ensureDirs();
  const meta: LedgerMeta = { ...l.meta, updated: new Date().toISOString() };
  const fm = YAML.stringify(meta).trimEnd();
  writeFileSync(l.path, `---\n${fm}\n---\n\n${l.body.replace(/^\n+/, "")}`);
}

export const LEDGER_TEMPLATE = (title: string): string => `# ${title}

## Why this exists
<!-- The intent, in prose. An agent that has never seen this task must be able to
     read this cold and understand what success looks like and why it matters.
     Lead with WHY: implementation choices are the best we had, not doctrine. -->

## Constraints & standing directives
<!-- Non-negotiables: stack, style, things that must not change, review gates. -->

## Current state
<!-- What is actually true right now. Overwrite this section each run; it is a
     snapshot, not a history. Be specific about files and their state. -->

Not started.

## Next
<!-- The ordered queue of work. The next agent starts at the top item. -->

1. Define the first increment.

## Landmines
<!-- Things already tried that failed, and traps that will re-break the build.
     Never delete an entry here; it is how we stop relearning the same lesson. -->

## Open questions
<!-- Things needing a human decision. Flag rather than guess. -->

## Handoffs
<!-- Append-only. One line per run: timestamp, agent, what changed. -->
`;

export function createLedger(opts: {
  id: string;
  title?: string;
  repo?: string;
  routing?: Partial<Record<string, BackendId[]>>;
}): Ledger {
  const now = new Date().toISOString();
  const title = opts.title ?? opts.id;
  const l: Ledger = {
    path: ledgerPath(opts.id),
    meta: {
      id: opts.id,
      title,
      status: "todo",
      repo: opts.repo ?? process.cwd(),
      created: now,
      updated: now,
      routing: opts.routing as LedgerMeta["routing"],
    },
    body: LEDGER_TEMPLATE(title),
  };
  writeLedger(l);
  return l;
}

/** Append a line to the Handoffs section, creating it when absent. */
export function appendHandoff(id: string, line: string): void {
  const l = readLedger(id);
  if (!l) return;
  const entry = `- ${new Date().toISOString()} — ${line}`;
  if (/^##\s+Handoffs\s*$/m.test(l.body)) {
    l.body = l.body.replace(/(^##\s+Handoffs\s*$)/m, `$1\n${entry}`);
  } else {
    l.body = `${l.body.trimEnd()}\n\n## Handoffs\n${entry}\n`;
  }
  writeLedger(l);
}

/** Replace the contents of a named `## Section`. Creates it when missing. */
export function updateSection(id: string, section: string, content: string): boolean {
  const l = readLedger(id);
  if (!l) return false;
  const re = new RegExp(`(^##[ \\t]+${escapeRe(section)}[ \\t]*$)([\\s\\S]*?)(?=^##[ \\t]+|(?![\\s\\S]))`, "m");
  if (re.test(l.body)) {
    l.body = l.body.replace(re, (_match, heading: string) => `${heading}\n\n${content.trim()}\n\n`);
  } else {
    l.body = `${l.body.trimEnd()}\n\n## ${section}\n\n${content.trim()}\n`;
  }
  writeLedger(l);
  return true;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The preamble every backend receives. This is the entire handoff mechanism:
 * state lives in the file, not in any agent's context window.
 */
export function composePrompt(
  l: Ledger,
  task: string,
  role: string,
  applicationStack?: { frontend?: string; backend?: string; delivery?: string; presentation?: string },
): string {
  const directives = directivesFor(l.meta.repo);
  const directiveBlock = directives
    ? `\n--- STANDING DIRECTIVES (how this user works — these outrank your defaults) ---\n${directives}\n--- END STANDING DIRECTIVES ---\n`
    : "";
  const stackBlock = applicationStack && Object.keys(applicationStack).length
    ? `
--- DEFAULT APPLICATION STACK ---
When asked to build an app, site, product, or tool without a specified or established stack, use:
${Object.entries(applicationStack).filter(([, value]) => value).map(([key, value]) => `- ${key}: ${value}`).join("\n")}
Explicit task requirements, ledger constraints, and an existing repository stack override this fallback.
--- END DEFAULT APPLICATION STACK ---
`
    : "";

  return `You are one of several coding agents working on a shared Fleet task. Your context
does not carry to the next agent; the ledger below does. Treat it as the source of truth.
${directiveBlock}${stackBlock}

LEDGER FILE: ${l.path}
ROLE FOR THIS RUN: ${role}
REPO: ${l.meta.repo}

--- BEGIN LEDGER ---
${l.body.trim()}
--- END LEDGER ---

Working agreement:
1. Read the ledger before acting. Respect "Landmines" — those failures are already paid for.
2. Do the work described under YOUR TASK below.
3. Before you finish, rewrite the ledger file at ${l.path} so a different agent from a
   different vendor could continue cold:
   - "Current state" — overwrite with what is now true (specific files, specific status).
   - "Next" — the ordered queue, top item first.
   - "Landmines" — append anything you discovered the hard way. Never delete entries.
   - "Open questions" — anything needing a human decision. Flag, do not guess.
   - "Handoffs" — append one line: what you changed and what you left undone.
4. If you are running out of room, stop early and spend your remaining budget updating the
   ledger. A correct ledger with half the work done beats finished work nobody can continue.
5. Do not mark the task done yourself. Fleet owns completion and its mandatory Vibemin gate.

YOUR TASK:
${task}`;
}
