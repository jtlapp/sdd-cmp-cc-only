import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { registerReset } from "../src/state.js";

test("GET /health: 200 with status:ok JSON body", async () => {
  const app = createApp();
  const res = await app.request("/health");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type")?.startsWith("application/json"), true);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("POST /reset: 204 with empty body and no X-Username header", async () => {
  const app = createApp();
  const res = await app.request("/reset", { method: "POST" });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
});

test("POST /reset: callable with an unregistered (well-formed) X-Username", async () => {
  // §4 normally requires registration; reset is exempt per §15.
  const app = createApp();
  const res = await app.request("/reset", {
    method: "POST",
    headers: { "X-Username": "never-registered" },
  });
  assert.equal(res.status, 204);
});

test("POST /reset: callable with a malformed X-Username", async () => {
  // Brief: reset must work against an empty registry and is exempt from §4.
  // That exemption covers the malformed case too.
  const app = createApp();
  const res = await app.request("/reset", {
    method: "POST",
    headers: { "X-Username": " alice" },
  });
  assert.equal(res.status, 204);
});

test("POST /reset: callable with an empty X-Username (null user)", async () => {
  const app = createApp();
  const res = await app.request("/reset", {
    method: "POST",
    headers: { "X-Username": "" },
  });
  assert.equal(res.status, 204);
});

test("POST /reset: idempotent — two calls in a row both return 204", async () => {
  const app = createApp();
  const a = await app.request("/reset", { method: "POST" });
  const b = await app.request("/reset", { method: "POST" });
  assert.equal(a.status, 204);
  assert.equal(b.status, 204);
});

test("POST /reset: invokes every registered reset callback", async () => {
  // Phase 1 has no domain state, but the central seam must wire callbacks
  // through. Phase 2+ rely on this.
  let calledA = 0;
  let calledB = 0;
  registerReset(() => calledA++);
  registerReset(() => calledB++);

  const app = createApp();
  const res = await app.request("/reset", { method: "POST" });
  assert.equal(res.status, 204);
  assert.ok(calledA >= 1, "callback A should have been invoked");
  assert.ok(calledB >= 1, "callback B should have been invoked");
});

test("GET on unknown path: 404 with §15.6 envelope, not Hono's default text", async () => {
  const app = createApp();
  const res = await app.request("/nope");
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("content-type")?.startsWith("application/json"), true);
  const body = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "not_found");
  assert.match(body.error.message, /GET/);
  assert.match(body.error.message, /\/nope/);
});

test("Unsupported method on a known path: error envelope, never raw text/HTML", async () => {
  const app = createApp();
  // /health only supports GET; POST should produce an envelope (status may be
  // 404 under Hono's path-only routing — the brief is about the body shape).
  const res = await app.request("/health", { method: "POST" });
  assert.notEqual(res.status, 200);
  assert.equal(res.headers.get("content-type")?.startsWith("application/json"), true);
  const body = (await res.json()) as { error: { code: string } };
  assert.ok(["not_found", "validation_error", "forbidden", "conflict"].includes(body.error.code));
});
