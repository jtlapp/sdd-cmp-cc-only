import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

import {
  ApiError,
  errorBody,
  httpError,
  STATUS_BY_CODE,
  type ApiErrorCode,
} from "../src/errors.js";

test("STATUS_BY_CODE: §15.6 mapping is exact", () => {
  assert.equal(STATUS_BY_CODE.validation_error, 400);
  assert.equal(STATUS_BY_CODE.forbidden, 403);
  assert.equal(STATUS_BY_CODE.not_found, 404);
  assert.equal(STATUS_BY_CODE.conflict, 409);
});

test("errorBody: envelope shape without details", () => {
  const b = errorBody("validation_error", "bad input");
  assert.deepEqual(b, { error: { code: "validation_error", message: "bad input" } });
});

test("errorBody: envelope shape with details", () => {
  const b = errorBody("conflict", "name clash", { field: "name" });
  assert.deepEqual(b, {
    error: { code: "conflict", message: "name clash", details: { field: "name" } },
  });
});

test("errorBody: omits details when undefined (not present as null)", () => {
  const b = errorBody("not_found", "no such taxon");
  assert.equal("details" in b.error, false);
});

test("httpError: each code returns its mapped status with the envelope", async () => {
  const cases: Array<{ code: ApiErrorCode; status: number }> = [
    { code: "validation_error", status: 400 },
    { code: "forbidden", status: 403 },
    { code: "not_found", status: 404 },
    { code: "conflict", status: 409 },
  ];

  for (const { code, status } of cases) {
    const app = new Hono();
    app.get("/x", (c) => httpError(c, code, `msg:${code}`));
    const res = await app.request("/x");
    assert.equal(res.status, status, `expected ${status} for ${code}`);
    assert.equal(res.headers.get("content-type")?.startsWith("application/json"), true);
    const body = await res.json();
    assert.deepEqual(body, { error: { code, message: `msg:${code}` } });
  }
});

test("httpError: passes through details", async () => {
  const app = new Hono();
  app.get("/x", (c) =>
    httpError(c, "conflict", "in-tree name clash", { tree: "r1", name: "Fantasy" }),
  );
  const res = await app.request("/x");
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: { details: Record<string, unknown> } };
  assert.deepEqual(body.error.details, { tree: "r1", name: "Fantasy" });
});

test("ApiError: carries code, message, and details", () => {
  const e = new ApiError("not_found", "missing taxon", { id: "t1" });
  assert.equal(e.code, "not_found");
  assert.equal(e.message, "missing taxon");
  assert.deepEqual(e.details, { id: "t1" });
  assert.ok(e instanceof Error);
});
