import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
// @ts-expect-error plain .mjs launcher
import { main, resolveArgs } from "./understudy.mjs";

const BIN = path.join(import.meta.dirname, "understudy.mjs");
const REPO = path.resolve(import.meta.dirname, "../../..");

describe("the understudy bin", () => {
  test("package.json points the bin at an executable launcher", () => {
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as { bin: Record<string, string> };
    expect(pkg.bin).toEqual({ understudy: "scripts/understudy.mjs" });
    expect(path.resolve(import.meta.dirname, "..", pkg.bin.understudy)).toBe(BIN);
    expect(readFileSync(BIN, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(statSync(BIN).mode & 0o111).not.toBe(0);
  });

  test("init --help exits 0 and prints the usage", () => {
    const run = spawnSync(process.execPath, [BIN, "init", "--help"], { encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("npx understudy init (--instagram-export");
    expect(run.stdout).toContain("--publish <dir>");
  });

  test("any other command exits 2 with the usage", () => {
    const run = spawnSync(process.execPath, [BIN, "bogus"], { encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('unknown command "bogus"');
    const bare = spawnSync(process.execPath, [BIN], { encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(bare.status).toBe(2);
  });

  test("path flags are resolved against the caller's directory, the child runs from the repository root", () => {
    expect(resolveArgs(["--instagram-export", "export.zip", "--email", "a@b.test", "--out", "../bank", "--publish", "d"], "/home/me/dl")).toEqual([
      "--instagram-export", "/home/me/dl/export.zip", "--email", "a@b.test", "--out", "/home/me/bank", "--publish", "/home/me/dl/d",
    ]);
    const calls: { args: string[]; cwd: string }[] = [];
    const code = main(["init", "--publish", "card-dir"], {
      cwd: "/home/me/dl",
      spawn: (_exe: string, args: string[], options: { cwd: string }) => (calls.push({ args, cwd: options.cwd }), { status: 7 }),
    });
    expect(code).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe(REPO);
    expect(calls[0].args.slice(1)).toEqual([
      "--env-file-if-exists=examples/app/.env.local",
      "examples/app/scripts/persona/init.ts",
      "--publish",
      "/home/me/dl/card-dir",
    ]);
    expect(calls[0].args[0]).toMatch(/tsx[\\/]dist[\\/]cli\.mjs$/);
  });
});
