import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/duration.mjs";

test("hours and minutes", () => assert.equal(parseDuration("1h30m"), 5400));
test("minutes and seconds", () => assert.equal(parseDuration("2m5s"), 125));
test("seconds", () => assert.equal(parseDuration("45s"), 45));
test("hours", () => assert.equal(parseDuration("2h"), 7200));
test("invalid throws", () => assert.throws(() => parseDuration("5x")));
