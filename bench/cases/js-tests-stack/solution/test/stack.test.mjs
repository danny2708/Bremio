import { test } from "node:test";
import assert from "node:assert/strict";
import { Stack } from "../src/stack.mjs";

test("pop returns last pushed first", () => {
  const s = new Stack();
  s.push(1);
  s.push(2);
  s.push(3);
  assert.equal(s.pop(), 3);
  assert.equal(s.pop(), 2);
  assert.equal(s.pop(), 1);
});

test("peek does not remove", () => {
  const s = new Stack();
  s.push("a");
  s.push("b");
  assert.equal(s.peek(), "b");
  assert.equal(s.peek(), "b");
  assert.equal(s.size, 2);
});

test("size tracks pushes and pops", () => {
  const s = new Stack();
  assert.equal(s.size, 0);
  s.push(1);
  s.push(2);
  assert.equal(s.size, 2);
  s.pop();
  assert.equal(s.size, 1);
});

test("pop on empty throws", () => {
  assert.throws(() => new Stack().pop());
});
