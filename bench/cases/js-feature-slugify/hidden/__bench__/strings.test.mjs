import { test } from "node:test";
import assert from "node:assert/strict";
import * as strings from "../src/strings.mjs";

test("slugify is exported", () => assert.equal(typeof strings.slugify, "function"));
test("basic", () => assert.equal(strings.slugify("Hello, World!"), "hello-world"));
test("diacritics and padding", () => assert.equal(strings.slugify("  Crème Brûlée  "), "creme-brulee"));
test("collapses runs", () => assert.equal(strings.slugify("a--b__c"), "a-b-c"));
test("only separators", () => assert.equal(strings.slugify("---"), ""));
test("digits kept", () => assert.equal(strings.slugify("Top 10 Tips"), "top-10-tips"));
test("capitalize still works", () => assert.equal(strings.capitalize("abc"), "Abc"));
