// Runs several commands side by side as children of this process and takes them all down together: when a signal
// arrives, or when any one of them exits. No dependency; `npm run dev` uses it to keep the package watchers and
// `next dev` alive for exactly as long as each other.
import { spawn } from "node:child_process";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * @param {{ name: string, cmd: string, args: string[], cwd?: string }[]} specs
 * @returns {Promise<number>} the exit code to leave with: the first child's to exit non-zero, else 0; 130 / 143 for a signal
 */
export function supervise(specs) {
  return new Promise((resolve) => {
    const children = specs.map((spec) => ({ spec, proc: spawn(spec.cmd, spec.args, { cwd: spec.cwd, stdio: "inherit" }), done: false }));
    let code;
    let stopping = false;

    const finish = () => {
      for (const s of SIGNALS) process.off(s, onSignal);
      resolve(code ?? 0);
    };
    const stop = (exitCode) => {
      code ??= exitCode;
      if (stopping) return;
      stopping = true;
      for (const c of children) if (!c.done) c.proc.kill("SIGTERM");
      // A child that ignores SIGTERM is not waited on forever.
      setTimeout(() => children.forEach((c) => !c.done && c.proc.kill("SIGKILL")), 5000).unref();
      if (children.every((c) => c.done)) finish();
    };
    const onSignal = (signal) => stop(signal === "SIGINT" ? 130 : 143);
    for (const s of SIGNALS) process.on(s, onSignal);

    for (const c of children) {
      c.proc.on("error", (err) => {
        console.error(`${c.spec.name}: could not start (${err.code ?? err.name})`);
        c.done = true;
        stop(1);
      });
      c.proc.on("exit", (status, signal) => {
        c.done = true;
        if (!stopping) console.error(`${c.spec.name}: exited (${signal ?? status}), stopping the others`);
        stop(status ?? 1);
        if (children.every((x) => x.done)) finish();
      });
    }
  });
}
