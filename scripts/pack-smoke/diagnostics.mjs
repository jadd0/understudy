// Sorts the lines of `tsc --pretty false` output into the consumer project's and the shipped packages' own diagnostics
// and everything else in `node_modules` (third-party declarations the installed packages merely pull in).
//   own:   a path outside `node_modules/`, or under `node_modules/@jadd0/`
//   other: any other `node_modules/` path
const DIAGNOSTIC = /^(.+?)\(\d+,\d+\): error TS\d+: /;

export function sortDiagnostics(output) {
  const own = [];
  const other = [];
  for (const line of output.split("\n")) {
    const m = DIAGNOSTIC.exec(line);
    if (!m) continue;
    const file = m[1].replaceAll("\\", "/");
    const thirdParty = /(^|\/)node_modules\//.test(file) && !/(^|\/)node_modules\/@jadd0\//.test(file);
    (thirdParty ? other : own).push(line);
  }
  return { own, other };
}
