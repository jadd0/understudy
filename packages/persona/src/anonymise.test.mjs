import assert from "node:assert/strict";
import { test } from "node:test";
import { anonymiseText, findEmails, findForeignHandles } from "./lib/anonymise.mjs";

const OWN = ["alice", "alice_alt"];

test("a third-party handle becomes @user", () => {
  assert.equal(anonymiseText("@someone hi", OWN), "@user hi");
  assert.equal(anonymiseText("thanks @a.b_c.", OWN), "thanks @user.");
});

test("own handles are kept, case-insensitively", () => {
  assert.equal(anonymiseText("@alice hi @Alice_Alt", OWN), "@alice hi @Alice_Alt");
});

test("email-like strings are removed and leave no handle behind", () => {
  const out = anonymiseText("mail dave@example.org or alice@example.com now", OWN);
  assert.equal(out, "mail [email] or [email] now");
  assert.deepEqual(findEmails(out), []);
  assert.deepEqual(findForeignHandles(out, OWN), []);
});

test("instagram profile urls lose a foreign handle but post urls stay", () => {
  assert.equal(anonymiseText("see instagram.com/somebody.x now", OWN), "see instagram.com/user now");
  assert.equal(anonymiseText("https://www.instagram.com/p/AAA1/", OWN), "https://www.instagram.com/p/AAA1/");
  assert.equal(anonymiseText("instagram.com/alice", OWN), "instagram.com/alice");
});

test("empty and non-string input is safe", () => {
  assert.equal(anonymiseText("", OWN), "");
  assert.equal(anonymiseText(undefined, OWN), "");
});

test("findForeignHandles reports only what anonymisation would change", () => {
  assert.deepEqual(findForeignHandles("@user @alice @bob_x", OWN), ["@bob_x"]);
});
