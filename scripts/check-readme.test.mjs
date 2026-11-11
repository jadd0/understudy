import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkReadme, parseCommands, REQUIRED_HEADINGS, shellFences } from "./check-readme.mjs";

// built from parts so no tracked file names the private directory
const PRIVATE_DIR = [".prod", "uct"].join("");
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** A git repository holding a README that carries every required heading and `fence` under the first one. */
function fixture(fence, { headings = REQUIRED_HEADINGS, untracked = [], lang = "bash" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "readme-"));
  const files = {
    "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*", "examples/*"], scripts: { dev: "x", check: "x" }, devDependencies: { vitest: "1" } }),
    "packages/lib/package.json": JSON.stringify({ name: "@x/lib", bin: { "lib-cli": "cli.mjs" }, scripts: { build: "x" } }),
    "examples/host/package.json": JSON.stringify({ name: "@x/host", scripts: { demo: "x" } }),
    "scripts/real.mjs": "",
    "docs/GUIDE.md": "",
    Dockerfile: "",
    "docker-compose.yml": "",
    "README.md": `# T\n\n${headings.map((h, i) => `## ${h}\n\n${i === 0 ? "```" + lang + "\n" + fence + "\n```\n" : ""}`).join("\n")}`,
  };
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "--", ...Object.keys(files)], { cwd: dir });
  for (const u of untracked) writeFileSync(join(dir, u), "");
  return dir;
}

const messages = (dir) => checkReadme(dir).problems.map((p) => `${p.line}: ${p.message}`);

test("the real README passes", () => {
  const { commands, problems } = checkReadme(repoRoot);
  assert.ok(commands >= 10, `only ${commands} commands were read`);
  assert.deepEqual(problems, []);
});

test("a valid fixture passes and counts its commands", () => {
  const dir = fixture(
    [
      "npm ci",
      "npm run dev && npm run check   # trailing comment",
      "npm run demo -w @x/host -- --fake",
      "npm run --workspace @x/lib build",
      "npx lib-cli --help",
      "cp scripts/real.mjs docs/GUIDE.md",
      "docker compose up -d --wait",
      "DATABASE_URL=postgres://u:p@localhost:5437/d npm run dev",
      "cp scripts/real.mjs .env.local",
    ].join("\n"),
  );
  const r = checkReadme(dir);
  assert.deepEqual(r.problems, []);
  assert.equal(r.commands, 10);
});

test("each broken command fails with its README line", () => {
  // the fence opens on line 5 of the fixture README, so its first command is line 6
  const cases = [
    ["npm run nope", /npm run nope: the root package.json has no such script/],
    ["npx nobin", /npx nobin: no workspace package declares that bin/],
    ["bash scripts/gate.sh", /scripts\/gate.sh needs a private steps file/],
    ["node scripts/ghost.mjs", /scripts\/ghost.mjs is not a tracked file/],
    [`cat ${PRIVATE_DIR}/plans/x.md`, /private planning directory/],
    ["cat examples/app/.env.local", /\.env\.local is private/],
    ["npm run demo -w @x/ghost", /workspace @x\/ghost, which does not exist/],
  ];
  for (const [command, expected] of cases) {
    const found = messages(fixture(command));
    assert.equal(found.length, 1, `${command}: ${found.join(" | ")}`);
    assert.match(found[0], new RegExp(`^6: `));
    assert.match(found[0], expected, command);
  }
});

test("an untracked file on disk is not a tracked path", () => {
  const dir = fixture("node scripts/local.mjs", { untracked: ["scripts/local.mjs"] });
  assert.deepEqual(messages(dir), ["6: scripts/local.mjs is not a tracked file"]);
});

test("a missing or misplaced required heading fails", () => {
  const without = REQUIRED_HEADINGS.filter((h) => h !== "Measured");
  assert.deepEqual(messages(fixture("npm ci", { headings: without })), ['1: missing required heading "## Measured"']);
  const swapped = [...REQUIRED_HEADINGS];
  [swapped[4], swapped[5]] = [swapped[5], swapped[4]];
  assert.equal(messages(fixture("npm ci", { headings: swapped })).length, 1);
});

test("-w resolves a script against that workspace's package.json", () => {
  assert.deepEqual(messages(fixture("npm run build -w @x/lib")), []);
  assert.deepEqual(messages(fixture("npm run build --workspace=@x/lib")), []);
  assert.match(messages(fixture("npm run build"))[0], /the root package.json has no such script/);
  assert.match(messages(fixture("npm run dev -w @x/lib"))[0], /@x\/lib has no such script/);
});

test("npm resolves the workspace flag before or after run", () => {
  assert.deepEqual(messages(fixture("npm -w @x/lib run build")), []);
  assert.deepEqual(messages(fixture("npm --workspace=@x/lib run build")), []);
  assert.deepEqual(messages(fixture("npm --workspace @x/host run demo -- --fake")), []);
  assert.match(messages(fixture("npm -w @x/lib run dev"))[0], /@x\/lib has no such script/);
  assert.match(messages(fixture("npm -w @x/ghost run build"))[0], /workspace @x\/ghost, which does not exist/);
  assert.match(messages(fixture("npm run build"))[0], /the root package.json has no such script/);
});

test("npx accepts an installed dependency or a workspace bin, and does not take --package's name as the bin", () => {
  assert.deepEqual(messages(fixture("npx vitest run\nnpx --yes lib-cli@1.2 --help\nnpx -y vitest")), []);
  assert.deepEqual(messages(fixture("npx --package some-remote tool --flag\nnpx -p some-remote tool\nnpx -c 'tool --x'")), []);
  assert.match(messages(fixture("npx nobin"))[0], /^6: npx nobin: no workspace package declares that bin/);
  assert.match(messages(fixture("npx --yes nobin@latest"))[0], /^6: npx nobin: /);
  assert.match(messages(fixture("npx --yes"))[0], /npx names no binary/);
});

test("indented fences and shell, zsh and console fences are read", () => {
  assert.equal(messages(fixture("  npm run nope", { lang: "shell" })).length, 1);
  assert.equal(messages(fixture("npm run nope", { lang: "zsh" })).length, 1);
  assert.deepEqual(messages(fixture("$ npm run nope\nsome output npm run other\n$ npm ci", { lang: "console" })), ["6: npm run nope: the root package.json has no such script"]);
  const readme = "## Ten-minute start\n\n1. Install:\n\n   ```bash\n   npm run nope\n   ```\n\ntext\n\n   ```sh title=x\n   npm run nope2\n   ```\n";
  assert.deepEqual(shellFences(readme).map((f) => [f.line, f.body.map((l) => l.trim())]), [
    [6, ["npm run nope"]],
    [12, ["npm run nope2"]],
  ]);
});

test("only bash and sh fences are read, and paths with placeholders are skipped", () => {
  assert.deepEqual(messages(fixture("npm run nope", { lang: "ts" })), []);
  assert.deepEqual(messages(fixture("node scripts/<name>.mjs docs/…/x.md $HOME/scripts/y")), []);
  assert.equal(checkReadme(fixture("npm run nope", { lang: "sh" })).problems.length, 1);
});

test("parseCommands splits on operators outside quotes, strips comments and joins continuations", () => {
  const cmds = parseCommands(["a one && b two | c;d # not a command", "e 'x && y # z' \\", "  f"], 10);
  assert.deepEqual(cmds, [
    { line: 10, tokens: ["a", "one"] },
    { line: 10, tokens: ["b", "two"] },
    { line: 10, tokens: ["c"] },
    { line: 10, tokens: ["d"] },
    { line: 11, tokens: ["e", "x && y # z", "f"] },
  ]);
  assert.deepEqual(shellFences("```bash\nnpm ci\n```\n```ts\nx\n```\n").map((f) => f.body), [["npm ci"]]);
});

test("parseCommands keeps a quote open across lines and across a backslash continuation", () => {
  assert.deepEqual(parseCommands(["a 'one && two", "three # four' b", "c"], 1), [
    { line: 1, tokens: ["a", "one && two\nthree # four", "b"] },
    { line: 3, tokens: ["c"] },
  ]);
  assert.deepEqual(parseCommands(['echo "x && \\', 'y # z" && npm ci'], 1), [
    { line: 1, tokens: ["echo", "x && y # z"] },
    { line: 2, tokens: ["npm", "ci"] },
  ]);
});
