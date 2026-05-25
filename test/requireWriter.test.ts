// PRD §4 — write gate ("null users may perform read operations only"),
// tested in isolation against a stand-in protected write route. Phase 2
// ships no production write endpoint; phases 4–7 will mount this on the
// real ones.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

import { ApiError, errorBody, STATUS_BY_CODE } from "../src/errors.js";
import type { AppEnv } from "../src/identity.js";
import { IDENTITY_KEY } from "../src/identity.js";
import { identityWithRegistry } from "../src/middleware/identity.js";
import { requireWriter } from "../src/middleware/requireWriter.js";
import { register, clear as clearRegistry } from "../src/registry.js";

type ErrorBody = { error: { code: string; message: string } };

/** identityWithRegistry → requireWriter → handler that echoes identity. */
function writeApp() {
  const app = new Hono<AppEnv>();
  app.post("/write", identityWithRegistry, requireWriter, (c) =>
    c.json({ identity: c.get(IDENTITY_KEY), ok: true }),
  );
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(errorBody(err.code, err.message, err.details), STATUS_BY_CODE[err.code]);
    }
    return c.json({ error: { code: "internal_error", message: "x" } }, 500);
  });
  return app;
}

// --- core gate behavior ----------------------------------------------------

test("requireWriter: null identity (no X-Username) → 403 forbidden", async () => {
  clearRegistry();
  const app = writeApp();
  const res = await app.request("/write", { method: "POST" });
  assert.equal(res.status, 403);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "forbidden");
  assert.match(body.error.message, /anonymous|null/i);
});

test("requireWriter: null identity (empty X-Username) → 403 forbidden", async () => {
  clearRegistry();
  const app = writeApp();
  const res = await app.request("/write", {
    method: "POST",
    headers: { "X-Username": "" },
  });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as ErrorBody).error.code, "forbidden");
});

test("requireWriter: registered identity → handler runs and sees canonical identity", async () => {
  clearRegistry();
  register("Alice");
  const app = writeApp();
  const res = await app.request("/write", {
    method: "POST",
    headers: { "X-Username": "Alice" },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; identity: { kind: string; username: string } };
  assert.equal(body.ok, true);
  assert.equal(body.identity.kind, "registered");
  assert.equal(body.identity.username, "Alice");
});

// --- short-circuit cases (identity layer handles them before requireWriter) -

test("chain: malformed X-Username short-circuits at identity layer → 400, never reaches write gate", async () => {
  // NBSP-prefixed — HTTP strips OWS but not NBSP, so this arrives malformed.
  clearRegistry();
  register("Alice");
  const app = writeApp();
  const res = await app.request("/write", {
    method: "POST",
    headers: { "X-Username": " alice" },
  });
  assert.equal(res.status, 400);
  // 400 from identity layer, not 403 from writer layer.
  assert.equal(((await res.json()) as ErrorBody).error.code, "validation_error");
});

test("chain: unregistered non-null X-Username short-circuits at identity layer → 403 forbidden (unregistered, not null-write)", async () => {
  clearRegistry();
  // No users registered.
  const app = writeApp();
  const res = await app.request("/write", {
    method: "POST",
    headers: { "X-Username": "ghost" },
  });
  assert.equal(res.status, 403);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "forbidden");
  // Message should indicate "unregistered" — distinct from the null-user
  // rejection wording — so observers can tell the two §4 outcomes apart.
  assert.match(body.error.message, /unregistered/i);
});

test("chain: registered caller with case-variant header → 200 (case-insensitive resolution)", async () => {
  clearRegistry();
  register("Alice");
  const app = writeApp();
  const res = await app.request("/write", {
    method: "POST",
    headers: { "X-Username": "ALICE" },
  });
  assert.equal(res.status, 200);
});
