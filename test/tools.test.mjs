import test from "node:test";
import assert from "node:assert/strict";
import { qs } from "../dist/tools.js";

test("qs: builds a query string and drops undefined/empty values", () => {
  assert.equal(qs({ status: "scheduled", limit: 20, offset: 0 }), "?status=scheduled&limit=20&offset=0");
  assert.equal(qs({ status: undefined, limit: 10 }), "?limit=10");
  assert.equal(qs({ status: "" }), "");
  assert.equal(qs({}), "");
});

test("qs: URL-encodes values", () => {
  assert.equal(qs({ q: "a b&c" }), "?q=a%20b%26c");
});
