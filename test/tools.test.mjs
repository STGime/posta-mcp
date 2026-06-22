import test from "node:test";
import assert from "node:assert/strict";
import { qs, ok } from "../dist/tools.js";

test("qs: builds a query string and drops undefined/empty values", () => {
  assert.equal(qs({ status: "scheduled", limit: 20, offset: 0 }), "?status=scheduled&limit=20&offset=0");
  assert.equal(qs({ status: undefined, limit: 10 }), "?limit=10");
  assert.equal(qs({ status: "" }), "");
  assert.equal(qs({}), "");
});

test("qs: URL-encodes values", () => {
  assert.equal(qs({ q: "a b&c" }), "?q=a%20b%26c");
});

// Regression: empty-body endpoints (DELETE / cancel / etc.) cause client.request()
// to resolve with `undefined`. JSON.stringify(undefined) returns undefined (not
// the string "undefined"), which produced `text: undefined` in the MCP content
// array and tripped the SDK's runtime schema validation on the client end.
test("ok: undefined resolves to a schema-valid text block", () => {
  const result = ok(undefined);
  assert.equal(typeof result.content[0].text, "string");
  assert.equal(result.content[0].type, "text");
  assert.equal(result.content[0].text, '{"ok":true}');
});

test("ok: null resolves to the same ack as undefined", () => {
  const result = ok(null);
  assert.equal(typeof result.content[0].text, "string");
  assert.equal(result.content[0].text, '{"ok":true}');
});

test("ok: strings pass through verbatim", () => {
  assert.equal(ok("hello").content[0].text, "hello");
});

test("ok: objects pretty-print as JSON", () => {
  const result = ok({ deleted: true, id: "abc-123" });
  assert.equal(typeof result.content[0].text, "string");
  assert.deepEqual(JSON.parse(result.content[0].text), { deleted: true, id: "abc-123" });
  // Pretty-printed (contains newlines).
  assert.ok(result.content[0].text.includes("\n"));
});
