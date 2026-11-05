import { test } from "node:test";
import assert from "node:assert/strict";
import { totalWithDiscount } from "../src/pricing.ts";

const cart = [
  { price: 1000, quantity: 2 },
  { price: 250, quantity: 1 },
];

test("applies quantity and percent", () => assert.equal(totalWithDiscount(cart, 10), 2025));
test("no discount", () => assert.equal(totalWithDiscount(cart, 0), 2250));
test("full discount", () => assert.equal(totalWithDiscount(cart, 100), 0));
test("rounds to nearest cent", () => assert.equal(totalWithDiscount([{ price: 333, quantity: 1 }], 50), 167));
test("negative discount throws", () => assert.throws(() => totalWithDiscount(cart, -1), RangeError));
test("over 100 throws", () => assert.throws(() => totalWithDiscount(cart, 101), RangeError));
