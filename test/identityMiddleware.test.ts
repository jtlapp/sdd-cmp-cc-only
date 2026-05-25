// PRD §4 — identity-resolution middleware tested in isolation against a
// stand-in protected route, since Phase 2 ships no production write
// endpoint (deferred to phases 4–7).
//
// Both middlewares are exercised:
//   - identityWithRegistry: the full §4 gate.
//   - identityFormatOnly:   the POST /users carve-out (decision #1).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

import { ApiError, errorBody, STATUS_BY_CODE } from "../src/errors.js";
import type { AppEnv, Identity } from "../src/identity.js";
import { IDENTITY_KEY } from "../src/identity.js";
import {
  identityFormatOnly,
  identityWithRegistry,
} from "../src/middleware/identity.js";
import { register, clear as clearRegistry } from "../src/registry.js";

type ErrorBody = { error: { code: string; message: string } };

/** Build a tiny app whose stand-in route just echoes the resolved identity. */
function gatedApp(which: "withRegistry" | "formatOnly") {
  const app = new Hono<AppEnv>();
  const mw = which === "withRegistry" ? identityWithRegistry : identityFormatOnly;
  app.get("/echo", mw, (c) => c.json({ identity: c.get(IDENTITY_KEY) }));
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(errorBody(err.code, err.message, err.details), STATUS_BY_CODE[err.code]);
    }
    return c.json({ error: { code: "internal_error", message: "x" } }, 500);
  });
  return app;
}

// --- identityWithRegistry: the four §4 outcomes ----------------------------

test("identityWithRegistry: absent header → handler sees null identity", async () => {
  clearRegistry();
  const app = gatedApp("withRegistry");
  const res = await app.request("/echo");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { identity: Identity };
  assert.deepEqual(body.identity, { kind: "null" });
});

test("identityWithRegistry: empty X-Username → handler sees null identity", async () => {
  clearRegistry();
  const app = gatedApp("withRegistry");
  const res = await app.request("/echo", { headers: { "X-Username": "" } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as { identity: Identity }, {
    identity: { kind: "null" },
  });
});

test("identityWithRegistry: malformed X-Username → 400 validation_error, handler never runs", async () => {
  // HTTP strips OWS (space + horizontal tab) from header values, and \n is
  // not even a legal header byte. To send a malformed-X-Username that
  // actually reaches the server malformed, use a non-OWS whitespace such as
  // NBSP ( ) — it matches the parser's \s rule but survives HTTP transit.
  clearRegistry();
  const app = gatedApp("withRegistry");

  for (const value of [" alice", "alice ", "   ", " "]) {
    const res = await app.request("/echo", { headers: { "X-Username": value } });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(value)}`);
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.error.code, "validation_error");
    assert.match(body.error.message, /X-Username/);
  }
});

test("identityWithRegistry: well-formed but unregistered → 403 forbidden, handler never runs", async () => {
  clearRegistry();
  const app = gatedApp("withRegistry");
  const res = await app.request("/echo", { headers: { "X-Username": "ghost" } });
  assert.equal(res.status, 403);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "forbidden");
  assert.match(body.error.message, /unregistered/i);
  assert.match(body.error.message, /ghost/);
});

test("identityWithRegistry: registered exact-case → handler sees canonical identity", async () => {
  clearRegistry();
  register("Alice");
  const app = gatedApp("withRegistry");
  const res = await app.request("/echo", { headers: { "X-Username": "Alice" } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as { identity: Identity }, {
    identity: { kind: "registered", username: "Alice" },
  });
});

test("identityWithRegistry: case-variant header maps to canonical form (decision #4)", async () => {
  clearRegistry();
  register("Alice");
  const app = gatedApp("withRegistry");

  for (const variant of ["alice", "ALICE", "AlIcE"]) {
    const res = await app.request("/echo", { headers: { "X-Username": variant } });
    assert.equal(res.status, 200, `expected 200 for ${variant}`);
    assert.deepEqual((await res.json()) as { identity: Identity }, {
      identity: { kind: "registered", username: "Alice" },
    });
  }
});

test("identityWithRegistry: malformed and unregistered both conform to §15.6 envelope", async () => {
  clearRegistry();
  const app = gatedApp("withRegistry");
  for (const { header, code } of [
    { header: " alice", code: "validation_error" }, // NBSP-prefixed, survives HTTP OWS-stripping
    { header: "ghost", code: "forbidden" },
  ]) {
    const res = await app.request("/echo", { headers: { "X-Username": header } });
    assert.equal(res.headers.get("content-type")?.startsWith("application/json"), true);
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.error.code, code);
    assert.equal(typeof body.error.message, "string");
    assert.ok(body.error.message.length > 0);
  }
});

// --- identityFormatOnly: registry check skipped ----------------------------

test("identityFormatOnly: absent header → null identity, handler runs", async () => {
  clearRegistry();
  const app = gatedApp("formatOnly");
  const res = await app.request("/echo");
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as { identity: Identity }, {
    identity: { kind: "null" },
  });
});

test("identityFormatOnly: malformed X-Username STILL 400s (format check applies)", async () => {
  // NBSP-prefixed — see note above.
  clearRegistry();
  const app = gatedApp("formatOnly");
  const res = await app.request("/echo", { headers: { "X-Username": " alice" } });
  assert.equal(res.status, 400);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "validation_error");
});

test("identityFormatOnly: unregistered well-formed header → handler runs (decision #1)", async () => {
  clearRegistry();
  const app = gatedApp("formatOnly");
  const res = await app.request("/echo", { headers: { "X-Username": "claire" } });
  assert.equal(res.status, 200);
  // The unregistered case is surfaced to the handler as null-shaped identity.
  assert.deepEqual((await res.json()) as { identity: Identity }, {
    identity: { kind: "null" },
  });
});

test("identityFormatOnly: registered header still resolves to canonical identity", async () => {
  clearRegistry();
  register("Bob");
  const app = gatedApp("formatOnly");
  const res = await app.request("/echo", { headers: { "X-Username": "bob" } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as { identity: Identity }, {
    identity: { kind: "registered", username: "Bob" },
  });
});
