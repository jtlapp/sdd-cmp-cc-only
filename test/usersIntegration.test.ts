// End-to-end through createApp — exercises the actual production wiring
// (POST /users + GET /users + middleware + reset) rather than stand-in
// routes, to cover the brief's "interactions with earlier phases" dimension.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";

type ErrorBody = { error: { code: string; message: string } };

async function freshApp() {
  const app = createApp();
  await app.request("/reset", { method: "POST" });
  return app;
}

function postJson(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("integration: register Alice and Bob, list, then 403/400 paths through createApp", async () => {
  const app = await freshApp();

  // Register two users with no X-Username (bootstrap mode).
  const a = await postJson(app, "/users", { username: "Alice" });
  const b = await postJson(app, "/users", { username: "Bob" });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);

  // GET as Alice → 200 with both names in registration order.
  const listAsAlice = await app.request("/users", { headers: { "X-Username": "Alice" } });
  assert.equal(listAsAlice.status, 200);
  assert.deepEqual(await listAsAlice.json(), { users: ["Alice", "Bob"] });

  // GET as null user → 200.
  const listAsNull = await app.request("/users");
  assert.equal(listAsNull.status, 200);

  // GET as unregistered "Carol" → 403.
  const listAsCarol = await app.request("/users", { headers: { "X-Username": "Carol" } });
  assert.equal(listAsCarol.status, 403);
  assert.equal(((await listAsCarol.json()) as ErrorBody).error.code, "forbidden");

  // GET with malformed header → 400 (decision #2 — universal format check).
  // NBSP-prefixed so HTTP doesn't strip the leading whitespace.
  const listMalformed = await app.request("/users", { headers: { "X-Username": " alice" } });
  assert.equal(listMalformed.status, 400);
  assert.equal(((await listMalformed.json()) as ErrorBody).error.code, "validation_error");
});

test("integration: POST /reset clears registry; previously-valid X-Username now 403s", async () => {
  const app = await freshApp();
  await postJson(app, "/users", { username: "Alice" });

  // Sanity: Alice can read now.
  const before = await app.request("/users", { headers: { "X-Username": "Alice" } });
  assert.equal(before.status, 200);

  // Wipe.
  const reset = await app.request("/reset", { method: "POST" });
  assert.equal(reset.status, 204);

  // Same header, now unregistered.
  const after = await app.request("/users", { headers: { "X-Username": "Alice" } });
  assert.equal(after.status, 403);

  // Listing is empty.
  const listing = await app.request("/users");
  assert.deepEqual(await listing.json(), { users: [] });
});

test("integration: POST /users error envelope codes round-trip through §15.6 helpers", async () => {
  const app = await freshApp();

  // 400 path — body-side malformed (a body string keeps its leading space;
  // no HTTP OWS-stripping applies to JSON request bodies).
  const bad = await postJson(app, "/users", { username: " alice" });
  assert.equal(bad.status, 400);
  const badBody = await bad.json() as { error: { code: string; message: string } };
  assert.equal(badBody.error.code, "validation_error");
  assert.equal(typeof badBody.error.message, "string");

  // 409 path
  await postJson(app, "/users", { username: "Alice" });
  const dup = await postJson(app, "/users", { username: "alice" });
  assert.equal(dup.status, 409);
  const dupBody = await dup.json() as { error: { code: string; details?: { existing: string } } };
  assert.equal(dupBody.error.code, "conflict");
  assert.equal(dupBody.error.details?.existing, "Alice");

  // 403 path (decision #2 — well-formed unregistered on GET /users)
  const forbidden = await app.request("/users", { headers: { "X-Username": "ghost" } });
  assert.equal(forbidden.status, 403);
  assert.equal(((await forbidden.json()) as ErrorBody).error.code, "forbidden");

  // 404 path (Phase 1 fallback for unknown routes still applies)
  const nf = await app.request("/users/nope");
  assert.equal(nf.status, 404);
  assert.equal(((await nf.json()) as ErrorBody).error.code, "not_found");
});

test("integration: /reset remains §4-exempt for malformed AND unregistered callers", async () => {
  const app = await freshApp();
  for (const headers of [
    {},
    { "X-Username": "" },
    { "X-Username": "never-registered" },
    { "X-Username": " malformed" }, // NBSP — actually malformed at the server
  ]) {
    const res = await app.request("/reset", { method: "POST", headers });
    assert.equal(res.status, 204, `reset must be 204 for ${JSON.stringify(headers)}`);
  }
});
