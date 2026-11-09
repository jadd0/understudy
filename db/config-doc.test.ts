import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ENGINE_CONFIG, RETRIEVAL_CONFIG, SIM_CONFIG, WALLET_CONFIG } from "./seed";

/** docs/CONFIG.md is the one list of every tunable value; this keeps it from drifting from the seed and the code. */
const doc = readFileSync("docs/CONFIG.md", "utf8");
const rows = (prefix: string) => new Map([...doc.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| .* \| (.+) \|$/gm)].filter((m) => m[1].startsWith(prefix) || prefix === "").map((m) => [m[1], m]));

describe("docs/CONFIG.md", () => {
  const seeded = { ...WALLET_CONFIG, ...ENGINE_CONFIG, ...RETRIEVAL_CONFIG, ...SIM_CONFIG };
  const documented = rows("");

  test("every seeded config row is documented with its seeded default", () => {
    for (const [key, value] of Object.entries(seeded)) {
      const row = documented.get(key);
      expect(row, `${key} is missing from docs/CONFIG.md`).toBeDefined();
      expect(row![2], `${key} default in docs/CONFIG.md`).toBe(JSON.stringify(value));
    }
  });

  test("every documented config row is seeded", () => {
    const constants = doc.slice(doc.indexOf("## Code constants"));
    for (const key of documented.keys()) if (!constants.includes(`| \`${key}\` |`)) expect(seeded, `${key} is documented but not seeded`).toHaveProperty([key]);
  });

  test("every documented code constant has that value in its file", () => {
    const constants = doc.slice(doc.indexOf("## Code constants"));
    const listed = [...constants.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \| `([^`]+)` \| .* \| `([^`]+)` \|$/gm)];
    expect(listed.length).toBeGreaterThan(10);
    for (const [, name, value, file] of listed) {
      expect(readFileSync(file, "utf8"), `${name} in ${file}`).toMatch(new RegExp(`const ${name}\\b[^=]*= ${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")};`));
    }
  });
});
