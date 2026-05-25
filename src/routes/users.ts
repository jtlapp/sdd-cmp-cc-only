// User registry routes from PRD §15.1.
//
//   POST /users  — body { username }. Mounted with identityFormatOnly so an
//                  unregistered (or null) caller can bootstrap. Malformed
//                  X-Username still 400s per Phase-2 decision #2.
//
//   GET /users   — list registered usernames in canonical casing. Mounted
//                  with identityWithRegistry so a non-null caller must be
//                  registered, matching §4 (decision #2). Null callers are
//                  allowed per §15.2.

import { Hono } from "hono";

import { ApiError } from "../errors.js";
import type { AppEnv } from "../identity.js";
import { identityFormatOnly, identityWithRegistry } from "../middleware/identity.js";
import { list, register } from "../registry.js";
import { parseUsername } from "../validation/username.js";

export const usersRouter = new Hono<AppEnv>();

usersRouter.post("/users", identityFormatOnly, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError("validation_error", "request body must be valid JSON");
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("validation_error", "request body must be a JSON object");
  }

  const raw = (body as Record<string, unknown>).username;
  if (typeof raw !== "string") {
    throw new ApiError(
      "validation_error",
      raw === undefined
        ? "missing required field: username"
        : "username must be a string",
    );
  }

  // §4 format rules. parseUsername returns "null" for empty string — but a
  // POST /users body of `{username: ""}` is clearly invalid input, not the
  // null user. Reject the empty-string case explicitly here.
  if (raw === "") {
    throw new ApiError("validation_error", "username must not be empty");
  }
  const parsed = parseUsername(raw);
  if (parsed.kind === "malformed") {
    throw new ApiError("validation_error", parsed.reason);
  }
  if (parsed.kind === "null") {
    // Unreachable given the empty-string guard above; keep total coverage
    // of parseUsername's return shape.
    throw new ApiError("validation_error", "username must not be empty");
  }

  const result = register(parsed.value);
  if (!result.ok) {
    throw new ApiError(
      "conflict",
      `username already registered: ${result.existing}`,
      { existing: result.existing },
    );
  }

  return c.json({ username: result.canonical }, 201);
});

usersRouter.get("/users", identityWithRegistry, (c) => {
  return c.json({ users: list() });
});
