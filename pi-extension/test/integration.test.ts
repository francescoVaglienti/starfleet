import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Activity, statusText, widgetLines } from "../lib/activity.ts";
import { EventTail, type FleetEvent } from "../lib/events.ts";
import { readSnapshot, toolNames } from "../lib/fleet.ts";
import { TaskView } from "../lib/view.ts";

const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));

function event(type: string, msg: string, runId = "run-one"): FleetEvent {
  return { ts: new Date().toISOString(), backend: "codex", taskId: "demo", runId, type, msg };
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "pi-fleet-"));
  await mkdir(join(home, "state"));
  await mkdir(join(home, "ledger"));
  await writeFile(join(home, "events.jsonl"), "");
  await writeFile(join(home, "ledger", "demo.md"), "---\nid: demo\ntitle: Demo\nstatus: in_progress\ncreated: now\nupdated: now\n---\n\n## Current state\n\nReady for review\n\n## Next\n\n1. Run checks\n\n## Landmines\n\nKeep history\n");
  return home;
}

for (const [runtime, bin] of [["npm", "bin"], ["Python", ".venv/bin"]]) {
test(`Pi loads all ten ${runtime} tools and executes Fleet through its real tool pipeline without model auth`, async () => {
  const home = await fixture();
  const previous = { FLEET_HOME: process.env.FLEET_HOME, PATH: process.env.PATH, PI_OFFLINE: process.env.PI_OFFLINE };
  process.env.FLEET_HOME = home;
  process.env.PATH = `${join(repo, bin!)}${delimiter}${process.env.PATH}`;
  process.env.PI_OFFLINE = "1";
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const settingsManager = SettingsManager.inMemory(runtime === "npm" ? {
      packages: [repo], skills: ["-" + join(homedir(), ".agents/skills/fleet")],
    } : {});
    const loader = new DefaultResourceLoader({
      cwd: home, agentDir: join(home, "pi"), settingsManager,
      noExtensions: runtime !== "npm", noSkills: runtime !== "npm", noContextFiles: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: runtime === "npm" ? [] : [entry],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    if (runtime === "npm") {
      const skill = loader.getSkills().skills.find((skill) => skill.name === "fleet");
      assert.ok(skill);
      assert.equal(await readFile(skill.filePath, "utf8"), await readFile(join(repo, "skill/SKILL.md"), "utf8"));
      assert.equal(resolve(skill.filePath), resolve(repo, "skill/SKILL.md"));
    }
    const sessionManager = SessionManager.inMemory(home);
    sessionManager.appendMessage({
      role: "assistant", api: "openai-responses", provider: "test-fixture", model: "recorded-tool-call",
      content: [{ type: "toolCall", id: "probe", name: "test-fixture", arguments: {} }],
      stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    ({ session } = await createAgentSession({
      cwd: home, agentDir: join(home, "pi"), resourceLoader: loader,
      settingsManager, sessionManager,
    }));
    await session.bindExtensions({});
    assert.deepEqual(session.getAllTools().map((tool) => tool.name).filter((name) => name.startsWith("fleet_")).sort(), [...toolNames].sort());
    const ctx = session.extensionRunner.createToolContext("probe", undefined);
    const schema = session.getAllTools().find((tool) => tool.name === "fleet_checkpoint")!.parameters as { properties: Record<string, unknown> };
    const properties = schema.properties;
    const taskKey = Object.hasOwn(properties, "taskId") ? "taskId" : "task_id";
    const status = await ctx.executeTool("fleet_status", {});
    assert.equal(status.isError, false, JSON.stringify(status));
    assert.match(JSON.stringify(status), /BACKENDS/);
    assert.match(JSON.stringify(status), /demo/);
    const events = await ctx.executeTool("fleet_events", runtime === "Python" ? { task_id: null } : {});
    assert.equal(events.isError, false, JSON.stringify(events));
    const checkpoint = await ctx.executeTool("fleet_checkpoint", { [taskKey]: "demo", state: "Round trip verified", next: "1. Review", handoff: "Pi integration probe" });
    assert.equal(checkpoint.isError, false);
    const ledger = await ctx.executeTool("fleet_ledger_read", { [taskKey]: "demo" });
    assert.match(JSON.stringify(ledger), /Round trip verified/);
    assert.doesNotMatch(JSON.stringify(ledger), /Ready for review|Run checks/);
    const rejected = await ctx.executeTool("fleet_ledger_read", { [taskKey]: "../outside" });
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected), /path traversal/);
    assert.match(await readFile(join(home, "ledger", "demo.md"), "utf8"), /Pi integration probe/);
  } finally {
    session?.dispose();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
});
}

test("real Pi RPC emits idle, live tool activity and completed state", { timeout: 40_000 }, async (t) => {
  const home = await fixture();
  const events = join(home, "events.jsonl");
  const child = spawn(process.env.PI_FLEET_TEST_PI ?? "pi", [
    "--mode", "rpc", "--no-session", "--offline", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-approve", "-e", entry,
  ], { cwd: home, env: { ...process.env, FLEET_HOME: home, PI_CODING_AGENT_DIR: join(home, "pi"), PATH: `${join(repo, "bin")}${delimiter}${process.env.PATH}` }, stdio: "pipe" });
  const records: Array<Record<string, any>> = [];
  let carry = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    const lines = (carry + chunk.toString()).split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) records.push(JSON.parse(line));
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const waitFor = async (predicate: (record: Record<string, any>) => boolean, from = 0) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const match = records.slice(from).find(predicate);
      if (match) return match;
      if (child.exitCode !== null) throw new Error(`Pi exited ${child.exitCode}: ${stderr}`);
      await delay(50);
    }
    throw new Error(`No expected RPC record. stderr=${stderr}\nrecords=${JSON.stringify(records)}`);
  };
  try {
    const idle = await waitFor((record) => record.method === "setStatus" && record.statusText === "fleet idle");
    t.diagnostic(JSON.stringify(idle));
    child.stdin.write(JSON.stringify({ id: "commands", type: "get_commands" }) + "\n");
    const commands = await waitFor((record) => record.id === "commands");
    assert.match(JSON.stringify(commands), /Live Fleet task view/);
    const start = event("run.start", "Synthetic delegation");
    await writeFile(join(home, "state", "lock-demo.json"), JSON.stringify({ backend: start.backend, taskId: start.taskId, runId: start.runId, since: start.ts, pid: process.pid }));
    await appendFile(events, JSON.stringify(start) + "\n");
    const running = await waitFor((record) => record.method === "setStatus" && record.statusText?.includes("fleet 1 running"));
    t.diagnostic(JSON.stringify(running));
    await appendFile(events, JSON.stringify(event("tool.call", "pnpm test")) + "\n");
    const widget = await waitFor((record) => record.method === "setWidget" && record.widgetLines?.some((line: string) => line.includes("tool.call pnpm test")));
    t.diagnostic(JSON.stringify(widget));
    child.stdin.write(JSON.stringify({ id: "status", type: "prompt", message: "/fleet status" }) + "\n");
    await waitFor((record) => JSON.stringify(record).includes("BACKENDS"));
    await rm(join(home, "state", "lock-demo.json"));
    const from = records.length;
    await appendFile(events, JSON.stringify(event("run.end", "completed")) + "\n");
    await waitFor((record) => record.method === "setStatus" && record.statusText === "fleet idle", from);
    await waitFor((record) => record.method === "setWidget" && record.widgetLines?.length === 0, from);
    assert.doesNotMatch(stderr, /Failed to load extension/);
  } finally {
    child.stdin.end();
    const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await Promise.race([exit, delay(3000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  }
});

test("event following survives partial UTF-8, rotation and truncate/regrow without rescanning history", async () => {
  const home = await fixture();
  const path = join(home, "events.jsonl");
  try {
    await writeFile(path, "{}\n".repeat(1_500_000));
    const tail = new EventTail(path);
    const received: FleetEvent[] = [];
    await tail.poll((event) => received.push(event));
    assert.ok(tail.bytesRead < 100);
    const start = event("run.start", "始める");
    const encoded = Buffer.from(JSON.stringify(start) + "\n");
    const split = encoded.indexOf(Buffer.from("始")) + 1;
    await appendFile(path, encoded.subarray(0, split));
    await tail.poll((event) => received.push(event));
    assert.equal(received.length, 0);
    await appendFile(path, encoded.subarray(split));
    await tail.poll((event) => received.push(event));
    assert.deepEqual(received, [start]);
    assert.ok(tail.bytesRead < 1000);
    await rename(path, `${path}.old`);
    const rotated = event("agent.text", "rotated");
    await writeFile(path, JSON.stringify(rotated) + "\n");
    await tail.poll((event) => received.push(event));
    const rewritten = event("agent.text", "replacement longer than the previous file " + "x".repeat(500));
    await writeFile(path, JSON.stringify(rewritten) + "\n");
    await tail.poll((event) => received.push(event));
    assert.deepEqual(received, [start, rotated, rewritten]);
    const activity = new Activity(home);
    activity.snapshot = { schemaVersion: 1, paths: { events: path, ledgerDir: join(home, "ledger") }, runs: [], tasks: [], backends: [{ id: "claude", cooldownUntil: "2099-01-01T00:00:00Z" }] };
    activity.accept(start);
    activity.accept(event("tool.call", "\x1b]52;c;secret\x07pnpm test"));
    assert.match(statusText(activity), /fleet 1 running.*cooldown claude/);
    assert.match(widgetLines(activity)[0]!, /tool.call pnpm test/);
    assert.doesNotMatch(widgetLines(activity)[0]!, /secret|\x1b/);
    const view = new TaskView("demo", activity.snapshot, home, () => {}, () => {}, () => 100);
    await view.update();
    const rendered = view.render(40);
    assert.match(rendered.join("\n"), /Ready for review/);
    assert.match(rendered.join("\n"), /Run checks/);
    assert.match(rendered.join("\n"), /replacement longer/);
    assert.ok(rendered.every((line) => visibleWidth(line) <= 40));
    await appendFile(path, JSON.stringify(event("run.end", "completed")) + "\n");
    await view.update();
    assert.match(view.render(80).join("\n"), /completed/);
    view.dispose();
    activity.accept(event("run.end", "completed"));
    assert.match(statusText(activity), /^fleet idle/);
    assert.deepEqual(widgetLines(activity), []);
    activity.stop();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("missing Fleet produces an install hint", async () => {
  const home = await fixture();
  const previous = process.env.PATH;
  try {
    process.env.PATH = home;
    await assert.rejects(readSnapshot(resolve(home)), /Install fleet-ai.*PATH/s);
  } finally {
    process.env.PATH = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("print and JSON commands return status without UI records or model auth", async () => {
  const home = await fixture();
  try {
    for (const mode of ["text", "json"]) {
      const execution = promisify(execFile)(process.env.PI_FLEET_TEST_PI ?? "pi", [
        "--mode", mode, "-p", "--no-session", "--offline", "--no-extensions", "--no-skills",
        "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-approve", "-e", entry, "/fleet status",
      ], { cwd: home, timeout: 15_000, env: {
        ...process.env, FLEET_HOME: home, PI_CODING_AGENT_DIR: join(home, "pi"),
        PATH: `${join(repo, "bin")}${delimiter}${process.env.PATH}`,
      } });
      execution.child.stdin?.end();
      const { stdout, stderr } = await execution;
      assert.match(mode === "text" ? stderr : stdout, /BACKENDS/);
      assert.doesNotMatch(stdout + stderr, /extension_ui_request/);
      if (mode === "json") {
        assert.equal(stderr, "");
        for (const line of stdout.trim().split("\n")) JSON.parse(line);
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("real status refresh clears crashed runs during other activity and preserves concurrent starts", async () => {
  const home = await fixture();
  const previous = { FLEET_HOME: process.env.FLEET_HOME, PATH: process.env.PATH };
  process.env.FLEET_HOME = home;
  process.env.PATH = `${join(repo, "bin")}${delimiter}${process.env.PATH}`;
  const activity = new Activity(home);
  try {
    await activity.refresh();
    activity.accept(event("run.start", "crashed process", "crashed"));
    const refreshing = activity.refresh();
    activity.accept(event("agent.text", "another run is still busy", "other"));
    await refreshing;
    assert.equal(activity.runs.size, 0);
    const starting = activity.refresh();
    activity.accept(event("run.start", "new process", "new"));
    await starting;
    assert.ok(activity.runs.has("new"));
    const run = { backend: "codex", taskId: "demo", runId: "new", since: new Date().toISOString(), pid: process.pid };
    await writeFile(join(home, "state", "lock-demo.json"), JSON.stringify(run));
    await activity.refresh();
    activity.accept(event("run.end", "process ending before lock release", "new"));
    await activity.refresh();
    assert.equal(activity.runs.size, 0);
  } finally {
    activity.stop();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
});
