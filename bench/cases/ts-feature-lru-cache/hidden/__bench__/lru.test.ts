import { test } from "node:test";
import assert from "node:assert/strict";
import { LruCache } from "../src/lru.ts";

test("get after set", () => {
  const c = new LruCache<string, number>(2);
  c.set("a", 1);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("missing"), undefined);
});

test("evicts least recently used", () => {
  const c = new LruCache<string, number>(2);
  c.set("a", 1);
  c.set("b", 2);
  c.get("a");
  c.set("c", 3);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("c"), 3);
  assert.equal(c.size, 2);
});

test("update refreshes recency without growing", () => {
  const c = new LruCache<string, number>(2);
  c.set("a", 1);
  c.set("b", 2);
  c.set("a", 10);
  c.set("c", 3);
  assert.equal(c.get("a"), 10);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.size, 2);
});

test("capacity below 1 throws", () => {
  assert.throws(() => new LruCache(0), RangeError);
});
