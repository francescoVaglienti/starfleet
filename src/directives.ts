import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { P } from "./paths.js";

/**
 * Standing directives — how this user works, expressed once and injected into
 * EVERY delegated prompt regardless of vendor. This is what stops Codex and
 * Copilot from behaving like strangers: Claude Code has memory files, they do
 * not, so the working agreement has to travel with the prompt.
 *
 * Layout:
 *   ~/.fleet/DIRECTIVES.md              global, always injected
 *   ~/.fleet/directives/<name>.md       scoped; injected when its `applies-to`
 *                                       path prefix matches the task's repo
 */
export interface DirectiveDoc {
  name: string;
  appliesTo: string[];
  body: string;
}

export function globalDirectives(): string {
  const p = join(P.home, "DIRECTIVES.md");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
}

export function scopedDirectives(repoPath: string): DirectiveDoc[] {
  const dir = join(P.home, "directives");
  if (!existsSync(dir)) return [];
  const out: DirectiveDoc[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const raw = readFileSync(join(dir, f), "utf8");
    const m = raw.match(/^<!--\s*applies-to:\s*(.+?)\s*-->/m);
    const appliesTo = m?.[1] ? m[1].split(/[,\s]+/).filter(Boolean) : [];
    if (appliesTo.length && !appliesTo.some((prefix) => repoPath.startsWith(prefix))) continue;
    out.push({ name: f.replace(/\.md$/, ""), appliesTo, body: raw.replace(/^<!--[\s\S]*?-->\s*/, "").trim() });
  }
  return out;
}

/** The full directive block for a task, or "" when nothing applies. */
export function directivesFor(repoPath: string): string {
  const parts: string[] = [];
  const g = globalDirectives();
  if (g) parts.push(g);
  for (const d of scopedDirectives(repoPath)) {
    parts.push(`<!-- scoped: ${d.name} -->\n${d.body}`);
  }
  return parts.join("\n\n");
}
