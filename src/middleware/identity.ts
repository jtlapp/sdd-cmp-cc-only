// Identity-resolution middleware from PRD §4.
//
// Every non-/reset endpoint runs one of these middlewares before its handler:
//
//   identityWithRegistry  — full §4 gate. Resolves X-Username into:
//       null              → handler runs, sees {kind: "null"}
//       malformed         → 400 validation_error, handler never runs
//       unregistered      → 403 forbidden, handler never runs
//       registered        → handler runs, sees {kind: "registered", username: <canonical>}
//
//   identityFormatOnly    — same, but the registry check is skipped. Used by
//       POST /users so the very first user can register without being
//       registered first (resolved Phase-2 decision #1). Malformed still 400s
//       per decision #2; non-null-unregistered is allowed through as a
//       null-shaped identity (the route handler in that mode does not depend
//       on the identity).
//
// /reset stays §4-exempt and uses neither middleware.

import type { MiddlewareHandler } from "hono";

import { ApiError } from "../errors.js";
import { canonicalOf } from "../registry.js";
import { parseUsername } from "../validation/username.js";
import type { AppEnv, Identity } from "../identity.js";
import { IDENTITY_KEY } from "../identity.js";

/** Full §4 gate: format check + registry check. */
export const identityWithRegistry: MiddlewareHandler<AppEnv> = async (c, next) => {
  const parsed = parseUsername(c.req.header("X-Username"));

  if (parsed.kind === "malformed") {
    throw new ApiError("validation_error", `malformed X-Username: ${parsed.reason}`);
  }

  if (parsed.kind === "null") {
    c.set(IDENTITY_KEY, { kind: "null" } satisfies Identity);
    await next();
    return;
  }

  // parsed.kind === "valid": format is OK; consult the registry.
  const canonical = canonicalOf(parsed.value);
  if (canonical === null) {
    throw new ApiError(
      "forbidden",
      `unregistered username: ${parsed.value}`,
    );
  }
  c.set(IDENTITY_KEY, { kind: "registered", username: canonical } satisfies Identity);
  await next();
};

/**
 * Format check only — used by POST /users. A well-formed but unregistered
 * X-Username does not block registration (it is treated as if the caller
 * had no identity for the purposes of the request); a malformed X-Username
 * still 400s per §4 / decision #2.
 *
 * The identity attached in the unregistered case is `{kind: "null"}`. The
 * POST /users handler does not consume identity, so this is purely
 * informational for any future caller.
 */
export const identityFormatOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  const parsed = parseUsername(c.req.header("X-Username"));

  if (parsed.kind === "malformed") {
    throw new ApiError("validation_error", `malformed X-Username: ${parsed.reason}`);
  }

  if (parsed.kind === "null") {
    c.set(IDENTITY_KEY, { kind: "null" } satisfies Identity);
  } else {
    const canonical = canonicalOf(parsed.value);
    if (canonical !== null) {
      c.set(IDENTITY_KEY, { kind: "registered", username: canonical } satisfies Identity);
    } else {
      // Well-formed but unregistered: pass through (decision #1). Identity
      // is null-shaped because the caller is not yet a known user.
      c.set(IDENTITY_KEY, { kind: "null" } satisfies Identity);
    }
  }
  await next();
};
