// PRD §15.1 — POST /users and GET /users.
//
// Per the toolchain supplement, state-touching tests call POST /reset first.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";

type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } };
type UsersList = { users: string[] };
type RegisterOk = { username: string };

async function freshApp() {
  const app = createApp();
  const reset = await app.request("/reset", { method: "POST" });
  assert.equal(reset.status, 204, "precondition: reset succeeds");
  return app;
}

function post(app: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// --- POST /users: success paths --------------------------------------------

test("POST /users: registers a well-formed name → 201 with canonical body", async () => {
  const app = await freshApp();
  const res = await post(app, "/users", { username: "Alice" });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("content-type")?.startsWith("application/json"), true);
  assert.deepEqual((await res.json()) as RegisterOk, { username: "Alice" });
});

test("POST /users: internal whitespace is allowed", async () => {
  const app = await freshApp();
  const res = await post(app, "/users", { username: "Anna Karenina Reader" });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { username: "Anna Karenina Reader" });
});

test("POST /users: single non-whitespace character", async () => {
  const app = await freshApp();
  const res = await post(app, "/users", { username: "a" });
  assert.equal(res.status, 201);
});

test("POST /users: multiple distinct registrations succeed in order", async () => {
  const app = await freshApp();
  await post(app, "/users", { username: "Alice" });
  await post(app, "/users", { username: "Bob" });
  await post(app, "/users", { username: "Carol" });
  const list = await app.request("/users");
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()) as UsersList, { users: ["Alice", "Bob", "Carol"] });
});

// --- POST /users: validation errors (400) ----------------------------------

test("POST /users: missing username field → 400 validation_error", async () => {
  const app = await freshApp();
  const res = await post(app, "/users", {});
  assert.equal(res.status, 400);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "validation_error");
  assert.match(body.error.message, /username/);
});

test("POST /users: non-string username (null, number, object, array) → 400", async () => {
  const cases: unknown[] = [null, 123, { name: "x" }, ["alice"], true];
  for (const username of cases) {
    const app = await freshApp();
    const res = await post(app, "/users", { username });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(username)}`);
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.error.code, "validation_error");
  }
});

test("POST /users: empty-string username → 400", async () => {
  const app = await freshApp();
  const res = await post(app, "/users", { username: "" });
  assert.equal(res.status, 400);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "validation_error");
  assert.match(body.error.message, /empty/);
});

test("POST /users: leading-whitespace username → 400", async () => {
  const app = await freshApp();
  const res = await post(app, "/users", { username: " alice" });
  assert.equal(res.status, 400);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "validation_error");
  assert.match(body.error.message, /begin/);
});

test("POST /users: trailing-whitespace username → 400", async () => {
  const app = await freshApp();
  const res = await post(app, "/users", { username: "alice " });
  assert.equal(res.status, 400);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "validation_error");
  assert.match(body.error.message, /end/);
});

test("POST /users: whitespace-only username (space/tab/newline) → 400", async () => {
  for (const username of [" ", "\t", "\n", "   "]) {
    const app = await freshApp();
    const res = await post(app, "/users", { username });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(username)}`);
  }
});

test("POST /users: malformed JSON body → 400", async () => {
  const app = await freshApp();
  const res = await post(app, "/users", "this is not json");
  assert.equal(res.status, 400);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "validation_error");
  assert.match(body.error.message, /JSON/);
});

test("POST /users: bare JSON value (string, array) instead of object → 400", async () => {
  for (const raw of [`"alice"`, `["alice"]`, `42`, `null`]) {
    const app = await freshApp();
    const res = await post(app, "/users", raw);
    assert.equal(res.status, 400, `expected 400 for raw body ${raw}`);
  }
});

// --- POST /users: duplicate conflict (409) ---------------------------------

test("POST /users: exact-duplicate registration → 409 conflict", async () => {
  const app = await freshApp();
  const a = await post(app, "/users", { username: "Alice" });
  assert.equal(a.status, 201);
  const b = await post(app, "/users", { username: "Alice" });
  assert.equal(b.status, 409);
  const body = (await b.json()) as ErrorBody;
  assert.equal(body.error.code, "conflict");
  assert.match(body.error.message, /Alice/);
  assert.deepEqual(body.error.details, { existing: "Alice" });
});

test("POST /users: case-variant duplicate → 409 (case-insensitive per §4)", async () => {
  const app = await freshApp();
  await post(app, "/users", { username: "Alice" });
  const res = await post(app, "/users", { username: "ALICE" });
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "conflict");
  assert.equal(body.error.details?.existing, "Alice");
});

test("POST /users: lower-then-upper duplicate also 409 (symmetric)", async () => {
  const app = await freshApp();
  await post(app, "/users", { username: "bob" });
  const res = await post(app, "/users", { username: "Bob" });
  assert.equal(res.status, 409);
});

// --- POST /users: caller X-Username variations (decisions #1, #2) ----------

test("POST /users: caller with NO X-Username can register → 201 (bootstrap)", async () => {
  // No header at all.
  const app = await freshApp();
  const res = await post(app, "/users", { username: "Alice" });
  assert.equal(res.status, 201);
});

test("POST /users: caller with empty X-Username (null user) can register → 201", async () => {
  const app = await freshApp();
  const res = await post(app, "/users", { username: "Alice" }, { "X-Username": "" });
  assert.equal(res.status, 201);
});

test("POST /users: unregistered well-formed X-Username can still register → 201", async () => {
  // Decision #1: registry-gate carve-out for POST /users.
  const app = await freshApp();
  const res = await post(app, "/users", { username: "Bob" }, { "X-Username": "claire" });
  assert.equal(res.status, 201);
  // The caller wasn't registered and didn't get themselves registered either —
  // only "Bob" landed in the registry.
  const list = await app.request("/users");
  assert.deepEqual((await list.json()) as UsersList, { users: ["Bob"] });
});

test("POST /users: registered caller can register a different name → 201", async () => {
  const app = await freshApp();
  await post(app, "/users", { username: "Alice" });
  const res = await post(app, "/users", { username: "Bob" }, { "X-Username": "Alice" });
  assert.equal(res.status, 201);
});

test("POST /users: malformed X-Username → 400 even with otherwise-valid body (decision #2)", async () => {
  // NB: HTTP strips OWS (space/tab) from header values, so a malformed
  // X-Username must use a non-OWS whitespace char (NBSP,  ) to actually
  // reach the server malformed. NBSP matches JS \s so parseUsername rejects it.
  const app = await freshApp();
  const res = await post(app, "/users", { username: "Alice" }, { "X-Username": " alice" });
  assert.equal(res.status, 400);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "validation_error");
  assert.match(body.error.message, /X-Username/);
  // And no side effect: the body's "Alice" must NOT have been registered.
  const list = await app.request("/users");
  assert.deepEqual((await list.json()) as UsersList, { users: [] });
});

// --- GET /users -----------------------------------------------------------

test("GET /users: empty registry → 200 with users: []", async () => {
  const app = await freshApp();
  const res = await app.request("/users");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type")?.startsWith("application/json"), true);
  assert.deepEqual((await res.json()) as UsersList, { users: [] });
});

test("GET /users: returns canonical first-registered casing (decision #4)", async () => {
  const app = await freshApp();
  await post(app, "/users", { username: "Alice" });
  await post(app, "/users", { username: "BOB" });
  const res = await app.request("/users");
  assert.deepEqual((await res.json()) as UsersList, { users: ["Alice", "BOB"] });
});

test("GET /users: available to the null user (no X-Username)", async () => {
  const app = await freshApp();
  await post(app, "/users", { username: "Alice" });
  const res = await app.request("/users");
  assert.equal(res.status, 200);
});

test("GET /users: available to a registered caller", async () => {
  const app = await freshApp();
  await post(app, "/users", { username: "Alice" });
  const res = await app.request("/users", { headers: { "X-Username": "Alice" } });
  assert.equal(res.status, 200);
});

test("GET /users: case-variant of a registered caller is accepted", async () => {
  const app = await freshApp();
  await post(app, "/users", { username: "Alice" });
  const res = await app.request("/users", { headers: { "X-Username": "ALICE" } });
  assert.equal(res.status, 200);
});

test("GET /users: unregistered non-null X-Username → 403 forbidden", async () => {
  // Decision #2: registry gate applies on all non-/reset, non-POST-/users endpoints.
  const app = await freshApp();
  await post(app, "/users", { username: "Alice" });
  const res = await app.request("/users", { headers: { "X-Username": "ghost" } });
  assert.equal(res.status, 403);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "forbidden");
  assert.match(body.error.message, /unregistered/i);
});

test("GET /users: malformed X-Username → 400 validation_error", async () => {
  // See note above re: NBSP for HTTP-survivable malformed headers.
  const app = await freshApp();
  const res = await app.request("/users", { headers: { "X-Username": " alice" } });
  assert.equal(res.status, 400);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "validation_error");
});

// --- Reset clears registry (§15) ------------------------------------------

test("POST /reset: clears the registry — list goes back to empty", async () => {
  const app = await freshApp();
  await post(app, "/users", { username: "Alice" });
  await post(app, "/users", { username: "Bob" });
  // Sanity
  const before = (await (await app.request("/users")).json()) as UsersList;
  assert.deepEqual(before, { users: ["Alice", "Bob"] });

  const reset = await app.request("/reset", { method: "POST" });
  assert.equal(reset.status, 204);

  const after = (await (await app.request("/users")).json()) as UsersList;
  assert.deepEqual(after, { users: [] });
});

test("POST /reset: post-reset, the previously-registered name is unregistered", async () => {
  const app = await freshApp();
  await post(app, "/users", { username: "Alice" });
  await app.request("/reset", { method: "POST" });
  // Re-registration succeeds (no leftover duplicate).
  const res = await post(app, "/users", { username: "Alice" });
  assert.equal(res.status, 201);
});

test("POST /reset: post-reset, prior X-Username is treated as unregistered → 403 on GET /users", async () => {
  const app = await freshApp();
  await post(app, "/users", { username: "Alice" });
  await app.request("/reset", { method: "POST" });
  const res = await app.request("/users", { headers: { "X-Username": "Alice" } });
  assert.equal(res.status, 403);
});
