import test from "node:test";
import assert from "node:assert/strict";
import { qs, ok, registerTools } from "../dist/tools.js";

/**
 * Tiny recording server used by the registerTools integration tests. The
 * real McpServer is heavier than we need here; capturing the registered
 * handlers lets us invoke them directly with a stub client and verify the
 * full guard+handler contract.
 */
function recordingServer() {
  const handlers = new Map();
  return {
    handlers,
    registerTool(name, _meta, handler) {
      handlers.set(name, handler);
    },
  };
}

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

// End-to-end through guard + handler: lock in the public contract that the
// destructive tools echo the affected id back, and that the response shape
// is MCP-schema-valid regardless of the upstream 204.

test("posta_delete_post: returns { deleted, id } as schema-valid text", async () => {
  const server = recordingServer();
  // 204 No Content from the API resolves with `undefined` — exactly the
  // path that produced the original crash.
  const client = { delete: async () => undefined };
  registerTools(server, client);

  const handler = server.handlers.get("posta_delete_post");
  assert.ok(handler, "handler should be registered");

  const result = await handler({ postId: "abc-123" });
  assert.equal(result.content[0].type, "text");
  assert.equal(typeof result.content[0].text, "string");
  assert.deepEqual(JSON.parse(result.content[0].text), { deleted: true, id: "abc-123" });
});

test("posta_cancel_post: returns { cancelled, id } as schema-valid text", async () => {
  const server = recordingServer();
  const client = { post: async () => undefined };
  registerTools(server, client);

  const handler = server.handlers.get("posta_cancel_post");
  assert.ok(handler);

  const result = await handler({ postId: "sched-9" });
  assert.equal(typeof result.content[0].text, "string");
  assert.deepEqual(JSON.parse(result.content[0].text), { cancelled: true, id: "sched-9" });
});

test("posta_delete_media: returns { deleted, id } as schema-valid text", async () => {
  const server = recordingServer();
  const client = { delete: async () => undefined };
  registerTools(server, client);

  const handler = server.handlers.get("posta_delete_media");
  assert.ok(handler);

  const result = await handler({ mediaId: "media-42" });
  assert.equal(typeof result.content[0].text, "string");
  assert.deepEqual(JSON.parse(result.content[0].text), { deleted: true, id: "media-42" });
});

test("guard: API errors still produce a schema-valid isError block", async () => {
  const server = recordingServer();
  const boom = new Error("boom from upstream");
  const client = { delete: async () => { throw boom } };
  registerTools(server, client);

  const handler = server.handlers.get("posta_delete_post");
  const result = await handler({ postId: "abc-123" });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].type, "text");
  assert.equal(typeof result.content[0].text, "string");
  assert.match(result.content[0].text, /boom from upstream/);
});
