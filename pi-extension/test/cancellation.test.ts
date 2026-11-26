import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const bridge = new URL("../lib/fleet.ts", import.meta.url).href;

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error("Timed out waiting for delegation fixture.");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const [runtime, bin, taskKey] of [["npm", "bin", "taskId"], ["Python", ".venv/bin", "task_id"]] as const) {
  test(`${runtime} delegation keeps its real lock after cancelling and exiting the Pi host`, { timeout: 25_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-fleet-cancel-"));
    const fixtureBin = join(home, "bin");
    await mkdir(fixtureBin);
    await mkdir(join(home, "ledger"));
    await writeFile(join(home, "ledger", "demo.md"), `---\nid: demo\ntitle: Cancellation fixture\nstatus: in_progress\nrepo: ${home}\ncreated: now\nupdated: now\n---\n\n## Current state\n\nFixture\n`);
    await writeFile(join(fixtureBin, "codex"), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.FLEET_FIXTURE_DIR;
fs.writeFileSync(path.join(home, 'backend.pid'), String(process.pid));
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fixture started'}}) + '\\n');
const poll = setInterval(() => {
  if (fs.existsSync(path.join(home, 'release'))) {
    clearInterval(poll);
    process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fixture completed'}}) + '\\n');
  }
}, 50);
`, { mode: 0o755 });
    const worker = join(home, "host.mjs");
    await writeFile(worker, `import { access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { callFleet } from ${JSON.stringify(bridge)};
const controller = new AbortController();
const operation = callFleet(process.cwd(), 'fleet_delegate', {${taskKey}:'demo',instruction:'Exercise a local process fixture',backend:'codex'}, controller.signal);
operation.catch(() => {});
while (!await access(${JSON.stringify(join(home, "backend.pid"))}).then(() => true, () => false)) await delay(25);
controller.abort();
try {
  await operation;
  process.exit(2);
} catch (error) {
  process.stdout.write(error.message + '\\n');
  process.exit(0);
}
`);
    const host = spawn(process.execPath, ["--experimental-strip-types", worker], {
      cwd: home,
      env: { ...process.env, FLEET_HOME: home, FLEET_FIXTURE_DIR: home, PATH: [fixtureBin, join(repo, bin), process.env.PATH].join(delimiter) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(host, "exit");
    let output = "";
    let errorOutput = "";
    host.stdout.on("data", (data) => { output += data.toString(); });
    host.stderr.on("data", (data) => { errorOutput += data.toString(); });
    let backendPid: number | undefined;
    let ownerPid: number | undefined;
    try {
      await until(() => access(join(home, "backend.pid")).then(() => true, () => false));
      backendPid = Number(await readFile(join(home, "backend.pid"), "utf8"));
      const [code] = await exited;
      assert.equal(code, 0, errorOutput);
      assert.match(output, /Stopped waiting.*worktree lock/);
      const lockName = (await readdir(join(home, "state"))).find((name) => name.startsWith("lock-"));
      assert.ok(lockName);
      ownerPid = JSON.parse(await readFile(join(home, "state", lockName), "utf8")).pid;
      await delay(200);
      assert.ok(alive(backendPid), "delegated process should continue");
      assert.ok(alive(ownerPid!), "Fleet's lock owner must outlive the Pi host");
      await writeFile(join(home, "release"), "");
      await until(async () => !(await readdir(join(home, "state"))).some((name) => name.startsWith("lock-")));
      const events = await readFile(join(home, "events.jsonl"), "utf8");
      assert.match(events, /run.end/);
      assert.doesNotMatch(events, /run.error/);
    } finally {
      if (host.exitCode === null) host.kill("SIGKILL");
      for (const pid of [backendPid, ownerPid]) if (pid && alive(pid)) process.kill(pid, "SIGTERM");
      await rm(home, { recursive: true, force: true });
    }
  });
}
