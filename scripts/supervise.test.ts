import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

const dir = mkdtempSync(path.join(os.tmpdir(), "supervise-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

/** Runs `supervise` in its own process over a sleeper (which records its pid) and a second command. */
function drive(name: string, second: string[]) {
  const pidFile = path.join(dir, `${name}.pids`);
  const driver = path.join(dir, `${name}.mjs`);
  const sleeper = ["-e", "require('fs').appendFileSync(process.argv[1], process.pid + '\\n'); setInterval(() => {}, 1000)", pidFile];
  writeFileSync(
    driver,
    `import { supervise } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "supervise.mjs")).href)};
process.exitCode = await supervise([
  { name: "sleeper", cmd: process.execPath, args: ${JSON.stringify(sleeper)} },
  { name: "second", cmd: process.execPath, args: ${JSON.stringify(second)} },
]);`,
  );
  const proc = spawn(process.execPath, [driver], { stdio: "ignore" });
  const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));
  const pids = () => (existsSync(pidFile) ? readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []);
  return { proc, exited, pids };
}

describe("supervise", () => {
  test("a signal to the supervisor takes down every child", async () => {
    const run = drive("signal", ["-e", "require('fs').appendFileSync(process.argv[1], process.pid + '\\n'); setInterval(() => {}, 1000)", path.join(dir, "signal.pids")]);
    await until(() => run.pids().length === 2, "both children to start");
    const children = run.pids();
    expect(children.every(alive)).toBe(true);
    run.proc.kill("SIGTERM");
    expect(await run.exited).toBe(143);
    await until(() => children.every((pid) => !alive(pid)), "the children to exit");
  });

  test("one child exiting non-zero stops the others and is the exit code", async () => {
    const run = drive("exit", ["-e", `setTimeout(() => process.exit(3), 2000)`]);
    await until(() => run.pids().length === 1, "the sleeper to start");
    const [sleeper] = run.pids();
    expect(alive(sleeper)).toBe(true);
    expect(await run.exited).toBe(3);
    await until(() => !alive(sleeper), "the sleeper to exit");
  });
});
