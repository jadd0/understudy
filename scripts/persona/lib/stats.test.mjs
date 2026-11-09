import assert from "node:assert/strict";
import { test } from "node:test";
import { histogram, lengthBucket, mean, wilson } from "./stats.mjs";

test("wilson_matches_known_values", () => {
  assert.deepEqual(wilson(50, 100), { lower: 0.4038, upper: 0.5962 });
  assert.deepEqual(wilson(0, 10), { lower: 0, upper: 0.2775 });
  assert.deepEqual(wilson(10, 10), { lower: 0.7225, upper: 1 });
});

test("wilson_zero_n_is_null", () => {
  assert.equal(wilson(0, 0), null);
  assert.equal(mean([]), null);
});

test("buckets_by_length", () => {
  assert.equal(lengthBucket("😂"), "<=10");
  assert.equal(lengthBucket("1234567890"), "<=10");
  assert.equal(lengthBucket("12345678901"), "11-30");
  assert.equal(lengthBucket("a".repeat(30)), "11-30");
  assert.equal(lengthBucket("a".repeat(31)), ">30");
});

test("histogram counts every score and rejects values outside the scale", () => {
  assert.deepEqual(histogram([1, 5, 5, 3]), { 1: 1, 2: 0, 3: 1, 4: 0, 5: 2 });
  assert.throws(() => histogram([6]), RangeError);
  assert.equal(mean([1, 2, 4]), 2.3333);
});
