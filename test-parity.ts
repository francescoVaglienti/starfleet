import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P } from "./dist/paths.js";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BACKENDS } from "./dist/backends/index.js";
import { composePrompt } from "./dist/ledger.js";
import { IMPORTANT_EVENT_TYPES, MCP_TOOL_NAMES, MCP_VERSION } from "./dist/mcp.js";
import { applicationStackFor, DEFAULT_POLICY, modelFor, routingFor, vibeminFor } from "./dist/policy.js";
import { renderBranch } from "./dist/worktree.js";
import {
  CODEX_STATUS_ITEMS,
  mergeClaudeStatusline,
  mergeCodexStatusline,
  setupHost,
} from "./dist/setup.js";
import { vibeminArgs } from "./dist/vibemin.js";
import { BACKEND_IDS } from "./dist/types.js";
import type { BackendId, Ledger, Policy, WorktreeRef } from "./dist/types.js";

const piCases = JSON.parse(readFileSync("tests/fixtures/pi-contract.json", "utf8"));

test("real CLIs reject unsafe flag typos and report a zero-exit agent failure", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-cli-safety-"));
  const env = { ...process.env, FLEET_HOME: home, PATH: `${home}:${process.env.PATH}`, UV_CACHE_DIR: "/tmp/fleet-uv-cache" };
  try {
    mkdirSync(join(home, "ledger"));
    writeFileSync(join(home, "policy.yaml"), "notify: {desktop: false, terminal: false}\n");
    writeFileSync(join(home, "ledger", "probe.md"), `---\nid: probe\ntitle: Probe\nstatus: in_progress\nrepo: ${JSON.stringify(home)}\ncreated: now\nupdated: now\n---\n\n## Current state\n\nReady\n`);
    writeFileSync(join(home, "agy"), "#!/bin/sh\nprintf '%s\\n' 'no output produced'\n", { mode: 0o755 });
    for (const [command, prefix] of [[process.execPath, ["bin/fleet"]], ["uv", ["run", "python", "-m", "fleet"]]] as const) {
      for (const invalid of [["--readonly"], ["--read-only=true"], ["--timeout", "abc"], ["--prompt", "--read-only"]]) {
        const result = spawnSync(command, [...prefix, "run", "probe", ...invalid], { env, encoding: "utf8", timeout: 20_000 });
        assert.equal(result.error, undefined);
        assert.notEqual(result.status, 0, `${command}: ${invalid.join(" ")}`);
        assert.doesNotMatch(result.stdout, /routing/);
      }
      const failed = spawnSync(command, [...prefix, "run", "probe", "--backend", "antigravity", "--read-only", "--prompt=Review"], { env, encoding: "utf8", timeout: 20_000 });
      assert.equal(failed.error, undefined);
      assert.equal(failed.status, 1, failed.stdout + failed.stderr);
      assert.match(failed.stdout + failed.stderr, /no output produced|produced no output/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("status JSON agrees across real CLIs with live, stale and corrupt state", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-status-parity-"));
  const env = { ...process.env, FLEET_HOME: home, UV_CACHE_DIR: "/tmp/fleet-uv-cache" };
  try {
    mkdirSync(join(home, "state"));
    mkdirSync(join(home, "ledger"));
    const run = { backend: "codex", taskId: "demo", runId: "run-one", pid: process.pid, since: "2026-01-01T00:00:00Z" };
    writeFileSync(join(home, "state", "lock-live.json"), JSON.stringify(run));
    writeFileSync(join(home, "state", "lock-stale.json"), JSON.stringify({ ...run, pid: 2147483647 }));
    writeFileSync(join(home, "state", "lock-invalid.json"), "{");
    writeFileSync(join(home, "state", "lock-null.json"), "null");
    writeFileSync(join(home, "state", "lock-bool.json"), JSON.stringify({ ...run, pid: true }));
    const empty = { ...run, backend: "", taskId: "", runId: "" };
    writeFileSync(join(home, "state", "lock-empty.json"), JSON.stringify(empty));
    writeFileSync(join(home, "state", "health.json"), JSON.stringify({
      claude: { state: "cooldown", cooldownUntil: "2099-01-01T00:00:00Z", reason: "quota", consecutiveFailures: 1 },
      codex: { state: "cooldown", cooldownUntil: "2000-01-01T00:00:00Z", reason: "expired", consecutiveFailures: 1 },
      pi: { state: "ok", consecutiveFailures: 0, lastResolvedModel: "configured-provider/configured-model" },
    }));
    writeFileSync(join(home, "ledger", "demo.md"), "---\nid: demo\ntitle: Demo\nstatus: in_progress\ncreated: now\nupdated: now\n---\n\n## Current state\n\nTesting\n");
    const ts = JSON.parse(execFileSync(process.execPath, ["bin/fleet", "status", "--json"], { env, encoding: "utf8" }));
    const py = JSON.parse(execFileSync("uv", ["run", "python", "-m", "fleet", "status", "--json"], { env, encoding: "utf8" }));
    assert.deepEqual(ts, py);
    assert.deepEqual(ts.runs, [empty, run]);
    assert.equal(ts.paths.events, join(home, "events.jsonl"));
    assert.equal(ts.backends.find((backend: { id: string }) => backend.id === "claude").cooldownUntil, "2099-01-01T00:00:00Z");
    assert.equal(ts.backends.find((backend: { id: string }) => backend.id === "codex").cooldownUntil, null);
    assert.equal(ts.backends.find((backend: { id: string }) => backend.id === "pi").model, null);
    assert.equal(ts.backends.find((backend: { id: string }) => backend.id === "pi").lastResolvedModel, "configured-provider/configured-model");
    assert.deepEqual(ts.tasks, [{ id: "demo", title: "Demo", status: "in_progress" }]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("both MCP executables replace checkpoint state literally and preserve prior landmines", async () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-checkpoint-parity-"));
  const outputs: string[] = [];
  try {
    mkdirSync(join(home, "ledger"));
    for (const [command, args] of [[process.execPath, ["bin/fleet", "mcp"]], ["uv", ["run", "python", "-m", "fleet", "mcp"]]] as const) {
      writeFileSync(join(home, "ledger", "demo.md"), "---\nid: demo\ntitle: Demo\nstatus: in_progress\ncreated: now\nupdated: now\n---\n\n## Current state\n\nOld state\n\n## Next\n\nOld next\n\n## Landmines\n\n- Original landmine\n");
      const client = new Client({ name: "parity", version: "1" });
      const transport = new StdioClientTransport({ command, args: [...args], env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        FLEET_HOME: home, UV_CACHE_DIR: "/tmp/fleet-uv-cache",
      }, stderr: "pipe" });
      transport.stderr?.on("data", () => {});
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        const properties = tools.find((tool) => tool.name === "fleet_checkpoint")!.inputSchema.properties!;
        const task = { [Object.hasOwn(properties, "taskId") ? "taskId" : "task_id"]: "demo" };
        const state = String.raw`New state with $& and \1 and \n kept literal`;
        const first = await client.callTool({ name: "fleet_checkpoint", arguments: { ...task, state, next: "New next", landmine: "Second landmine" } });
        assert.ok(!first.isError, JSON.stringify(first));
        const second = await client.callTool({ name: "fleet_checkpoint", arguments: { ...task, landmine: "Third landmine" } });
        assert.ok(!second.isError, JSON.stringify(second));
        const body = readFileSync(join(home, "ledger", "demo.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
        assert.ok(body.includes(state), `${command}: ${body}`);
        assert.doesNotMatch(body, /Old state|Old next/);
        assert.match(body, /Original landmine[\s\S]*Second landmine[\s\S]*Third landmine/);
        outputs.push(body);
      } finally {
        await client.close();
      }
    }
    assert.equal(outputs[0], outputs[1]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Antigravity captures Gemini stream text and distinguishes failures from quoted diagnostics", () => {
  const backend = BACKENDS.antigravity;
  const event = (name: string, body: Record<string, unknown>) => JSON.stringify({ event: name, [name]: body });
  assert.equal(backend.parseLine(event("init", { model: "gemini-3.8-flash-high" }))?.type, "run.start");
  assert.deepEqual(backend.parseLine(event("step_update", {
    step_type: "agent_response", state: "ACTIVE", text_delta: "FLEET_GEMINI_OK",
  })), { type: "agent.text", msg: "FLEET_GEMINI_OK" });
  const success = event("result", { status: "SUCCESS", response: "RESOURCE_EXHAUSTED no output produced" });
  assert.equal(backend.parseLine(success)?.type, "agent.reasoning");
  assert.equal(backend.detectFailure?.(success, 0), null);
  assert.equal(backend.detectExhaustion(success, 0), null);
  const tool = event("step_update", {
    step_type: "tool", state: "DONE", tool_info: { output: "RESOURCE_EXHAUSTED" },
  });
  assert.equal(backend.detectExhaustion(tool + "\n" + success, 0), null);
  const failure = event("result", { status: "ERROR", error: "RESOURCE_EXHAUSTED" });
  assert.equal(backend.parseLine(failure)?.type, "run.error");
  assert.match(backend.detectFailure?.(failure, 0) ?? "", /ERROR/);
  assert.equal(backend.detectExhaustion(failure, 0)?.kind, "quota");
  assert.equal(backend.detectExhaustion("UNAUTHENTICATED\n", 0)?.kind, "auth");
});

test("Fleet pins the requested provider models and effort flags", () => {
  assert.deepEqual(DEFAULT_POLICY.models.claude, { model: "claude-opus-5", effort: "high" });
  assert.deepEqual(DEFAULT_POLICY.models.antigravity, { model: "gemini-3.8-flash-high", effort: "high" });
  assert.deepEqual(DEFAULT_POLICY.models.copilot, { model: "gpt-5.3-codex", effort: "high" });
  const options = { taskId: "probe", runId: "probe", prompt: "check", cwd: "/tmp", effort: "high" };
  assert.ok(BACKENDS.copilot.buildArgs(options).includes("--reasoning-effort"));
  assert.ok(BACKENDS.antigravity.buildArgs({ ...options, readOnly: true }).includes("plan"));
});

test("TypeScript and Python share the public behavior contract", () => {
  const policy = structuredClone(DEFAULT_POLICY) as Policy;
  policy.projects["/tmp/acme"] = {
    routing: { implement: ["claude", "codex"] },
    models: {
      codex: { model: "project-sol", effort: "max" },
    },
    applicationStack: { delivery: "a tested vertical slice" },
    vibemin: { checks: ["pnpm test", "pnpm run typecheck"], maxAttempts: 42 },
  };
  const options = {
    taskId: "parity",
    runId: "12345678",
    prompt: "build it",
    cwd: "/tmp/acme",
    model: "model-x",
    effort: "high",
    readOnly: false,
    extraDirs: ["/tmp/ledger"],
  };
  const worktree: WorktreeRef = {
    repo: "/tmp/acme",
    path: "/tmp/acme-wt",
    branch: "task/demo",
    base: "main",
  };
  const ledger = {
    meta: {
      id: "parity",
      title: "Parity",
      status: "in_progress",
      repo: "/tmp/acme",
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      worktrees: [worktree],
    },
    body: "# Parity",
    path: "/tmp/parity.md",
  } as Ledger;
  const backendIds: BackendId[] = ["codex", "claude", "copilot", "antigravity", "mimo", "pi"];
  const actual = {
    backendIds: BACKEND_IDS,
    defaultRouting: DEFAULT_POLICY.routing,
    piContract: piContract(),
    piArgs: [false, true].flatMap((readOnly) =>
      [undefined, "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map((effort) =>
        BACKENDS.pi.buildArgs({ ...options, model: "provider/model:low", effort, readOnly }))),
    routing: routingFor(policy, "/tmp/acme", "implement"),
    models: Object.fromEntries(
      backendIds.map((backend) => [
        backend,
        modelFor(policy, "/tmp/acme", backend),
      ]),
    ),
    stack: applicationStackFor(policy, "/tmp/acme"),
    branchWithTicket: renderBranch(
      { branchPattern: "{kind}/{ticket}-{slug}" },
      { kind: "feature", ticket: "123", slug: "demo-app" },
    ),
    branchWithoutTicket: renderBranch(
      { branchPattern: "{kind}/{ticket}-{slug}" },
      { kind: "feature", slug: "demo-app" },
    ),
    backendArgs: Object.fromEntries(
      backendIds.map((backend) => [backend, BACKENDS[backend].buildArgs(options)]),
    ),
    readOnlyBackendArgs: Object.fromEntries(BACKEND_IDS.map((id) => [id, BACKENDS[id].buildArgs({ ...options, readOnly: true })])),
    vibeminArgs: vibeminArgs(policy, ledger, worktree),
    integration: {
      codexStatusItems: [...CODEX_STATUS_ITEMS],
      claudeStatusLine: mergeClaudeStatusline({ theme: "dark" }).config.statusLine,
      mcpVersion: MCP_VERSION,
      mcpToolNames: [...MCP_TOOL_NAMES],
      importantEventTypes: [...IMPORTANT_EVENT_TYPES],
    },
  };
  const python = JSON.parse(
    execFileSync("uv", ["run", "python", "scripts/parity_probe.py"], {
      encoding: "utf8",
      env: { ...process.env, UV_CACHE_DIR: "/tmp/fleet-uv-cache" },
    }),
  );
  assert.deepEqual(actual, python);
});

test("npm and PyPI executables report the shared version", () => {
  assert.equal(execFileSync(process.execPath, ["bin/fleet", "--version"], { encoding: "utf8" }), "fleet 0.2.0\n");
  assert.equal(
    execFileSync("uv", ["run", "python", "-m", "fleet", "--version"], {
      encoding: "utf8",
      env: { ...process.env, UV_CACHE_DIR: "/tmp/fleet-uv-cache" },
    }),
    "fleet 0.2.0\n",
  );
});

test("status-line setup preserves existing host preferences", () => {
  const codex = mergeCodexStatusline(
    '[tui]\nstatus_line = ["current-dir"]\nstatus_line_use_colors = false\nnotifications = true\n',
  );
  assert.match(codex, /"current-dir"/);
  assert.match(codex, /"task-progress"/);
  assert.match(codex, /status_line_use_colors = false/);
  assert.match(codex, /notifications = true/);

  const chosen = { statusLine: { type: "command", command: "my-bar" } };
  assert.deepEqual(mergeClaudeStatusline(chosen), { config: chosen, changed: false });
});

test("Codex setup targets the current user skill directory", () => {
  assert.match(setupHost("codex", true).skill ?? "", /\.agents\/skills\/fleet\/SKILL\.md$/);
});

test("npm and PyPI install the same Fleet skill", () => {
  assert.equal(
    readFileSync("skill/SKILL.md", "utf8"),
    readFileSync("fleet/resources/fleet-skill.md", "utf8"),
  );
});

test("delegated projects receive neutral application guidance", (t) => {
  const privateHome = P.home;
  const testHome = mkdtempSync(join(tmpdir(), "fleet-prompt-"));
  P.home = testHome;
  t.after(() => {
    P.home = privateHome;
    rmSync(testHome, { recursive: true, force: true });
  });
  const ledger = {
    meta: {
      id: "readme",
      title: "README",
      status: "in_progress",
      repo: "/tmp/demo",
      created: "now",
      updated: "now",
      worktrees: [],
    },
    body: "# README",
    path: "/tmp/readme.md",
  } as Ledger;
  const prompt = composePrompt(
    ledger,
    "build it",
    "implement",
    applicationStackFor(DEFAULT_POLICY, "/tmp/demo"),
  );
  assert.match(prompt, /README with setup, usage, and known limits/);
  assert.doesNotMatch(prompt, /Next\.js|Supabase|custom hero/);
});

test("MiMo rejects missing credentials and clears inherited Claude tokens", (t) => {
  const previous = { MIMO_API_KEY: process.env.MIMO_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const environment = BACKENDS.mimo.env;
  assert.ok(environment);
  const options = { taskId: "auth-check", runId: "check", prompt: "check", cwd: "/tmp" };
  delete process.env.MIMO_API_KEY;
  assert.throws(() => environment(options), /MiMo requires MIMO_API_KEY/);
  process.env.MIMO_API_KEY = "  ";
  assert.throws(() => environment(options), /MiMo requires MIMO_API_KEY/);
  process.env.MIMO_API_KEY = "test-only-key";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-only-oauth";
  const result = environment(options);
  assert.equal(result.ANTHROPIC_AUTH_TOKEN, "test-only-key");
  assert.equal(result.ANTHROPIC_API_KEY, "");
  assert.equal(result.CLAUDE_CODE_OAUTH_TOKEN, "");
});


function piContract() {
  return piCases.map((sample) => {
    const lines = sample.events.map((event) => JSON.stringify(event));
    const stream = [...lines, sample.stderr ?? ""].join("\n");
    const diagnostics = lines.map((line) => BACKENDS.pi.diagnosticLine!(line)).filter(Boolean);
    return {
      events: lines.map((line) => BACKENDS.pi.parseLine(line)).filter(Boolean),
      failure: BACKENDS.pi.detectFailure!(stream, sample.exitCode),
      exhaustion: BACKENDS.pi.detectExhaustion(stream, sample.exitCode),
      diagnosticFailure: BACKENDS.pi.detectFailure!([...diagnostics, sample.stderr ?? ""].join("\n"), sample.exitCode),
    };
  });
}

test("Pi preserves completed messages and only fails over on terminal provider diagnostics", () => {
  for (const [index, result] of piContract().entries()) {
    const sample = piCases[index];
    assert.equal(result.failure, sample.failure, sample.name);
    assert.equal(result.diagnosticFailure, sample.failure, sample.name);
    assert.equal(result.exhaustion?.kind ?? null, sample.kind, sample.name);
    if (sample.retryAfterMs) assert.equal(result.exhaustion?.retryAfterMs, sample.retryAfterMs);
    if (sample.types) assert.deepEqual(result.events.map((event) => event.type), sample.types);
    if (sample.text) {
      const message = result.events.find((event) => event.type === "agent.text");
      assert.equal(message?.msg, sample.text);
      assert.equal(message?.data.usage.totalTokens, 19);
    }
  }
  const options = { taskId: "contract", runId: "contract", cwd: "/tmp", prompt: "--review" };
  const args = BACKENDS.pi.buildArgs({ ...options, readOnly: true, effort: "ultra", model: "provider/id:low" });
  assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls");
  assert.ok(args.includes("--no-extensions") && args.includes("--no-mcp"));
  assert.equal(args[args.indexOf("--thinking") + 1], "max");
  assert.equal(args[args.indexOf("--model") + 1], "provider/id:low");
  assert.deepEqual(args.slice(-2), ["--", "--review"]);
  assert.throws(() => BACKENDS.pi.buildArgs({ ...options, effort: "invalid" }), /Unsupported Pi effort/);
});
