// Fails when README.md would send a stranger down a dead end: a shell command that names an npm script, an npx
// binary or a repository path that does not exist, a command that needs a private file, or a missing section.
//   node scripts/check-readme.mjs [root]
// Only ```bash, ```sh, ```shell, ```zsh and ```console fences are read (indented ones too; in a console fence only
// the lines that start with a `$ ` prompt). Comments are stripped and a line is split on &&, ||, ; and |. Prints one
// line per problem as README.md:<line>: <what>, then `readme: <n> commands, <k> problems`; exits 1 on a problem.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The `##` headings the README must carry, in this order. */
export const REQUIRED_HEADINGS = [
  "Ten-minute start",
  "Run it in a container",
  "Onboard a creator",
  "Use the engine in your own host",
  "What it does",
  "Measured",
  "Layout",
  "Checks",
  "Docs",
  "Responsibility",
];

const PATH_ROOTS = /^(examples|packages|scripts|docs|data)\//;
const ROOT_FILES = new Set(["Dockerfile", "docker-compose.yml"]);
// Needs a private file or only exists in a developer's checkout; never printed for a stranger to run.
const BANNED = [
  { re: /(^|\/)scripts\/gate\.sh$/, why: "scripts/gate.sh needs a private steps file; use npm run check" },
  { re: /(^|\/)\.product(\/|$)/, why: "the private planning directory is not in the public tree" },
];
const NPM_VALUE_FLAGS = new Set(["-w", "--workspace"]);
const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console"]);
// npx flags that name the package to fetch or a command line to run: the first word is then not a bin to look up.
const NPX_REMOTE_FLAGS = new Set(["-p", "--package", "-c", "--call"]);

/**
 * Splits a fenced block into commands. Each is { line, tokens } where `line` is where the command starts.
 * Quotes are respected, so an operator or `#` inside a quoted string stays in it; `\` at a line end continues.
 */
export function parseCommands(lines, firstLine) {
  const commands = [];
  let tokens = [];
  let word = null;
  let startLine = firstLine;
  const endWord = () => {
    if (word !== null) tokens.push(word);
    word = null;
  };
  // Open quote, carried across lines: a quoted string may span lines, and `\` ends a line inside double quotes too.
  let quote = null;
  const endCommand = (at) => {
    endWord();
    if (tokens.length) commands.push({ line: startLine, tokens });
    tokens = [];
    startLine = at;
  };
  lines.forEach((raw, i) => {
    const lineNo = firstLine + i;
    if (!tokens.length && word === null) startLine = lineNo;
    let continued = false;
    for (let j = 0; j < raw.length; j++) {
      const c = raw[j];
      if (quote) {
        if (c === "\\" && quote === '"' && j === raw.length - 1) continued = true;
        else if (c === quote) quote = null;
        else word += c;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        word ??= "";
      } else if (c === "#" && (word === null || word === "")) {
        break;
      } else if (c === "\\" && j === raw.length - 1) {
        endWord();
        return;
      } else if (c === " " || c === "\t") {
        endWord();
      } else if (c === "&" && raw[j + 1] === "&") {
        endCommand(lineNo);
        j++;
      } else if (c === "|" && raw[j + 1] === "|") {
        endCommand(lineNo);
        j++;
      } else if (c === ";" || c === "|") {
        endCommand(lineNo);
      } else {
        word = (word ?? "") + c;
      }
    }
    if (quote) {
      if (!continued) word += "\n";
      return;
    }
    endCommand(lineNo + 1);
  });
  endCommand(firstLine + lines.length);
  return commands;
}

/**
 * The shell fences of `text`: [{ line (of the first command line), body: string[] }]. A fence may be indented (inside
 * a list); a console fence keeps only its `$ ` prompt lines, with the prompt removed.
 */
export function shellFences(text) {
  const lines = text.split("\n");
  const fences = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^\s*```(\w+)(\s.*)?$/);
    if (!open) continue;
    const end = lines.findIndex((l, k) => k > i && /^\s*```\s*$/.test(l));
    if (end === -1) break;
    if (SHELL_LANGS.has(open[1])) {
      const body = lines.slice(i + 1, end);
      fences.push({ line: i + 2, body: open[1] === "console" ? body.map((l) => (/^\s*\$ /.test(l) ? l.replace(/^\s*\$ /, "") : "")) : body });
    }
    i = end;
  }
  return fences;
}

/** Root and workspace manifests: { root, workspaces: Map(name -> manifest) }. */
function loadManifests(root) {
  const read = (dir) => JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
  const rootPkg = read(".");
  const workspaces = new Map();
  for (const pattern of rootPkg.workspaces ?? []) {
    const base = pattern.replace(/\/\*$/, "");
    if (!existsSync(join(root, base))) continue;
    for (const d of readdirSync(join(root, base))) {
      if (!existsSync(join(root, base, d, "package.json"))) continue;
      const pkg = read(`${base}/${d}`);
      workspaces.set(pkg.name, pkg);
    }
  }
  return { root: rootPkg, workspaces };
}

/** Every dependency name any manifest declares: what `npx <name>` can run from the install. */
function declaredDeps(manifests) {
  const names = new Set();
  for (const pkg of [manifests.root, ...manifests.workspaces.values()]) {
    for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) for (const n of Object.keys(pkg[group] ?? {})) names.add(n);
  }
  return names;
}

/** Checks one `npx` command; returns a problem string or null. */
function checkNpx(cmd, root, bins, deps) {
  const args = cmd.slice(1);
  if (args.some((t) => NPX_REMOTE_FLAGS.has(t) || t.startsWith("--package=") || t.startsWith("--call="))) return null;
  const at = args.findIndex((t) => !t.startsWith("-"));
  if (at === -1) return "npx names no binary";
  const bin = args[at].replace(/(?<=.)@[^@/]*$/, "");
  if (bins.has(bin) || deps.has(bin) || existsSync(join(root, "node_modules", ".bin", bin))) return null;
  return `npx ${bin}: no workspace package declares that bin and it is not an installed dependency`;
}

function binNames(pkg) {
  if (typeof pkg.bin === "string") return [pkg.name.replace(/^@[^/]+\//, "")];
  return Object.keys(pkg.bin ?? {});
}

function trackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter(Boolean);
}

/** Checks one `npm run` command; returns a problem string or null. */
function checkNpmRun(tokens, manifests) {
  const rest = tokens.slice(1);
  const runAt = rest.findIndex((t) => t === "run" || t === "run-script");
  if (runAt === -1) return null;
  let workspace = null;
  let script = null;
  // The workspace flag may come before `run` (`npm -w x run s`) or after the script name.
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--") break;
    if (i === runAt) continue;
    if (NPM_VALUE_FLAGS.has(t)) workspace = rest[++i];
    else if (t.startsWith("--workspace=")) workspace = t.slice("--workspace=".length);
    else if (t.startsWith("-")) continue;
    else if (i > runAt) script ??= t;
  }
  if (script === null) return "npm run names no script";
  const pkg = workspace === null ? manifests.root : manifests.workspaces.get(workspace);
  if (!pkg) return `npm run names workspace ${workspace}, which does not exist`;
  if (!pkg.scripts?.[script]) return `npm run ${script}: ${workspace ?? "the root package.json"} has no such script`;
  return null;
}

/**
 * Reads README.md under `root` and returns { commands, problems }, each problem { line, message }.
 * `tracked` overrides the file list (default: `git ls-files`).
 */
export function checkReadme(root, { tracked } = {}) {
  const text = readFileSync(join(root, "README.md"), "utf8");
  const files = new Set(tracked ?? trackedFiles(root));
  const dirs = new Set([...files].flatMap((f) => f.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
  const manifests = loadManifests(root);
  const bins = new Set([...manifests.workspaces.values()].flatMap(binNames));
  const deps = declaredDeps(manifests);
  const problems = [];
  let commands = 0;

  // Required headings, in order.
  const headings = text.split("\n").flatMap((l, i) => (/^## /.test(l) ? [{ name: l.slice(3).trim(), line: i + 1 }] : []));
  let cursor = 0;
  for (const want of REQUIRED_HEADINGS) {
    const at = headings.findIndex((h, i) => i >= cursor && h.name === want);
    if (at === -1) {
      const elsewhere = headings.some((h) => h.name === want);
      problems.push({ line: 1, message: elsewhere ? `heading "## ${want}" is out of order` : `missing required heading "## ${want}"` });
    } else cursor = at + 1;
  }

  for (const fence of shellFences(text)) {
    for (const { line, tokens } of parseCommands(fence.body, fence.line)) {
      commands++;
      const cmd = [...tokens];
      while (cmd.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd[0])) cmd.shift();
      if (!cmd.length) continue;
      const problem = (message) => problems.push({ line, message });

      if (cmd[0] === "npm") {
        const p = checkNpmRun(cmd, manifests);
        if (p) problem(p);
      } else if (cmd[0] === "npx") {
        const p = checkNpx(cmd, root, bins, deps);
        if (p) problem(p);
      }

      const isCp = cmd[0] === "cp";
      cmd.forEach((tok, i) => {
        const value = tok.startsWith("-") && tok.includes("=") ? tok.slice(tok.indexOf("=") + 1) : tok;
        if (/[<…$]/.test(value)) return;
        for (const b of BANNED) if (b.re.test(value)) return problem(b.why);
        if (/(^|\/)\.env\.local$/.test(value)) {
          if (!(isCp && i === cmd.length - 1)) problem(".env.local is private; it may only be the target of cp");
          return;
        }
        if (!PATH_ROOTS.test(value) && !ROOT_FILES.has(value)) return;
        if (!files.has(value) && !dirs.has(value.replace(/\/$/, ""))) problem(`${value} is not a tracked file`);
      });
    }
  }
  return { commands, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { commands, problems } = checkReadme(process.argv[2] ?? process.cwd());
  for (const p of problems) console.log(`README.md:${p.line}: ${p.message}`);
  console.log(`readme: ${commands} commands, ${problems.length} problems`);
  process.exit(problems.length === 0 ? 0 : 1);
}
