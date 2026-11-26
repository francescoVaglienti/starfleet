---
name: fleet
description: Orchestrate durable coding work across Codex, Claude Code, Gemini/Antigravity, GitHub Copilot, Xiaomi MiMo, and Pi with isolated Git worktrees, shared ledgers, automatic failover, and Vibemin consolidation gates. Use when the user says fleet, delegate, hand off, run in parallel, check agent status, continue a task on another coding agent, or asks to create or refresh a public project README.
---

# Fleet

Fleet gives several coding agents one durable task ledger. Context stays in files, not in a
vendor session, so another backend can continue cold.

## Start here

Call `fleet_status` before delegating. It reports installed and cooling-down backends plus
active tasks. Read an existing task with `fleet_ledger_read` before changing it.

## Workflow

1. Create substantial work with `fleet_task_new`; Fleet creates an isolated worktree.
2. Put intent, constraints, and the ordered next steps in the ledger with `fleet_checkpoint`.
3. Use `fleet_delegate`. Prefer `wait: false` for long work and poll `fleet_events`.
4. Use a reviewer from a different model family than the author.
5. Keep the ledger current before context gets low or a provider limit is reached.
6. Consolidate the delegated changes and resolve review findings, then run Vibemin once
   at the end of consolidation through `fleet_task_done`. Do not run Vibemin per worker,
   task increment, or review; checkpoint their results for consolidation instead.

## Project defaults

Follow the task and the repository's existing stack and style. Fleet does not prescribe a
framework, database, visual style, or README layout. For new applications, choose tools that
fit the requirements. Deliver working behavior with end-to-end checks and document setup,
usage, and known limits.

These prompt defaults come from `defaults.applicationStack` in `~/.fleet/policy.yaml`.
Override its `frontend`, `backend`, `delivery`, and `presentation` fields globally or under a
project, or set `applicationStack: false` to disable the block. Treat explicit user and project
instructions as authoritative, including when they differ from this skill's guidance.

Do not edit `~/.fleet` state ad hoc when an MCP tool exists. Never delete a task worktree,
branch, ledger, or log merely to resolve a coordination failure.
