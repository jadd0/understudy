// Fakes for tests that drive the persona pipeline without the network: a fetch that serves the
// recorded Instagram fixtures, a Claude that drafts a well-formed card, and the zip writer.
// Nothing here is used outside tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SECTIONS, exampleRange } from "./draft-card.mjs";

export { writeZip } from "./export/test-zip.mjs";

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/instagram/", import.meta.url));

/**
 * A fetch that serves the fixtures by URL and throws on any URL without one, so no test reaches the network.
 * `overrides` maps a path-and-query to a handler; `log` collects every request.
 */
export function fixtureFetch({ routes, dir = FIXTURE_DIR, overrides = {}, log = [] } = {}) {
  const table = routes ?? JSON.parse(readFileSync(join(dir, "routes.json"), "utf8"));
  return async (url, init) => {
    log.push({ url, init });
    const parsed = new URL(url);
    const key = parsed.pathname + parsed.search;
    if (overrides[key]) return overrides[key](url, init);
    const file = table[key];
    if (!file) throw new Error(`no fixture for ${key}`);
    return new Response(readFileSync(join(dir, `${file}.json`), "utf8"), { status: 200, headers: { "content-type": "application/json" } });
  };
}

/**
 * A Claude that answers the card prompt with the seven sections and an EXAMPLE_IDS line built from the ids the
 * prompt lists after its pairs or lines header. `calls` collects every request.
 */
export function fakeCardClaude({ calls = [] } = {}) {
  return {
    async complete({ model, system, prompt, maxTokens }) {
      calls.push({ model, system, prompt, maxTokens });
      const header = /^=== (?:PAIRS|HER LINES) .*===$/m.exec(prompt);
      const listed = header ? [...prompt.slice(header.index).matchAll(/^\[([^\]\n]+)\] /gm)].map((m) => m[1]) : [];
      const ids = listed.slice(0, exampleRange(listed.length).min);
      const bodies = {
        Identity: "- an invented account for tests (src: profile)",
        Examples: "<<EXAMPLES>>",
        Never: "- contact details\n- real-world meetups",
      };
      const card = SECTIONS.map((name) => `## ${name}\n${bodies[name] ?? "Stay in her voice."}`).join("\n");
      return {
        text: `${card}\nEXAMPLE_IDS: ${ids.join(", ")}\n`,
        model,
        stopReason: "end_turn",
        usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: 400 },
      };
    },
  };
}
