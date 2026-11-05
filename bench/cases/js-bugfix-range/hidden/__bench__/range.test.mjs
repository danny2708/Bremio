import { test } from "node:test";
import assert from "node:assert/strict";
import { range } from "../src/range.mjs";

test("includes the end", () => assert.deepEqual(range(1, 3), [1, 2, 3]));
test("single value", () => assert.deepEqual(range(2, 2), [2]));
test("step lands on end", () => assert.deepEqual(range(0, 10, 5), [0, 5, 10]));
test("step overshoots end", () => assert.deepEqual(range(0, 9, 5), [0, 5]));
test("empty when start > end", () => assert.deepEqual(range(5, 1), []));
