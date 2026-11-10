import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { InitError, UsageError, USAGE, main, parseInitArgs } from "./init";

const REPO = path.resolve(import.meta.dirname, "../../../..");
const OUTSIDE = path.join(os.tmpdir(), "init-parse-test");
const DRAFT = ["--instagram-export", "export.zip", "--email", "wren@example.test", "--card-model", "a-model"];

describe("parseInitArgs", () => {
  test("a draft needs exactly one source", () => {
    expect(parseInitArgs(DRAFT)).toMatchObject({ kind: "draft", source: { kind: "export", input: path.resolve("export.zip") } });
    expect(parseInitArgs(["--scrape-own", "--email", "wren@example.test", "--card-model", "m"])).toMatchObject({ source: { kind: "scrape" } });
    expect(() => parseInitArgs(["--email", "wren@example.test", "--card-model", "m"])).toThrow(/exactly one of/);
    expect(() => parseInitArgs([...DRAFT, "--scrape-own"])).toThrow(/exactly one of/);
    expect(() => parseInitArgs([...DRAFT, "--publish", "dir"])).toThrow(/exactly one of/);
  });

  test("--email and --card-model are required to draft", () => {
    expect(() => parseInitArgs(["--scrape-own", "--card-model", "m"])).toThrow(/--email is required/);
    expect(() => parseInitArgs(["--scrape-own", "--email", "wren@example.test"])).toThrow(/--card-model is required/);
    expect(() => parseInitArgs(["--scrape-own", "--email", "not an email", "--card-model", "m"])).toThrow(/not an email address/);
  });

  test("--publish takes a directory and nothing else", () => {
    expect(parseInitArgs(["--publish", "some/dir"])).toEqual({ kind: "publish", dir: path.resolve("some/dir") });
    expect(() => parseInitArgs(["--publish", "dir", "--email", "wren@example.test"])).toThrow(/takes no other flag/);
    expect(() => parseInitArgs(["--publish"])).toThrow(/needs a value/);
  });

  test("unknown flags, stray words and repeated flags are refused", () => {
    expect(() => parseInitArgs([...DRAFT, "--wat", "1"])).toThrow(UsageError);
    expect(() => parseInitArgs([...DRAFT, "extra"])).toThrow(/unexpected argument/);
    expect(() => parseInitArgs([...DRAFT, "--email", "b@example.test"])).toThrow(/given twice/);
    expect(parseInitArgs(["--help"])).toEqual({ kind: "help" });
  });

  test("--handle must look like an Instagram username", () => {
    expect(parseInitArgs([...DRAFT, "--handle", "wren.fixture"])).toMatchObject({ handle: "wren.fixture" });
    for (const bad of ["../x", "..", "a b", ""]) expect(() => parseInitArgs([...DRAFT, "--handle", bad])).toThrow(UsageError);
  });

  test("--out inside the repository is refused, outside is accepted", () => {
    for (const inside of [REPO, path.join(REPO, "data", "mine"), path.join(REPO, "examples", "..", "x")]) {
      expect(() => parseInitArgs([...DRAFT, "--out", inside]), inside).toThrow(/outside this repository/);
    }
    expect(parseInitArgs([...DRAFT, "--out", OUTSIDE])).toMatchObject({ out: OUTSIDE });
  });
});

describe("main", () => {
  test("--help prints the usage and exits 0; a bad command line exits 2", async () => {
    const lines: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (line: string) => void lines.push(line);
    console.error = (line: string) => void lines.push(line);
    try {
      expect(await main(["--help"], {})).toBe(0);
      expect(await main([], {})).toBe(2);
    } finally {
      console.log = log;
      console.error = error;
    }
    expect(lines[0]).toBe(USAGE);
    expect(lines[1]).toMatch(/exactly one of/);
    expect(new InitError("x")).toBeInstanceOf(Error);
  });
});
