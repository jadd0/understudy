import { test } from "node:test";
import assert from "node:assert/strict";
import { addExamples } from "./add-examples.mjs";

const pairsById = new Map([
  ["t1", { id: "t1", replying_to: "UR SO HOT", text: "@user you are😏" }],
  ["t2", { id: "t2", replying_to: "hi", text: "@user hi" }],
]);
const card = "## Identity\n- x\n\n## Examples\n**Fan:** hi\n**Juno:** hi\n\n## Not known\n- y\n";

test("appends rendered pairs at the end of Examples, mentions stripped, other sections untouched", () => {
  const out = addExamples({ card, ids: ["t1"], pairsById, personaName: "Juno" });
  assert.equal(out, "## Identity\n- x\n\n## Examples\n**Fan:** hi\n**Juno:** hi\n\n**Fan:** UR SO HOT\n**Juno:** you are😏\n\n## Not known\n- y\n");
});

test("refuses an id outside the train pairs", () => {
  assert.throws(() => addExamples({ card, ids: ["test-id"], pairsById, personaName: "Juno" }), /not train reply ids/);
});

test("refuses a pair already in the card and duplicate ids", () => {
  assert.throws(() => addExamples({ card, ids: ["t2"], pairsById, personaName: "Juno" }), /already in the card/);
  assert.throws(() => addExamples({ card, ids: ["t1", "t1"], pairsById, personaName: "Juno" }), /duplicate/);
});
