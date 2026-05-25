// Write gate from PRD §4: "Null user may perform read operations only. Any
// write by the null user is forbidden."
//
// Applied AFTER `identityWithRegistry` on write endpoints. By the time this
// runs, the identity has already been resolved — malformed has 400'd and
// unregistered has 403'd in the identity layer. The remaining decision is
// just: null → 403, registered → pass.
//
// Phase 2 has no production write endpoints (deferred to phases 4–7); this
// middleware is exercised against a stand-in protected route in tests, per
// the brief's "prove the middleware in isolation" obligation.

import type { MiddlewareHandler } from "hono";

import { ApiError } from "../errors.js";
import type { AppEnv } from "../identity.js";
import { IDENTITY_KEY } from "../identity.js";

export const requireWriter: MiddlewareHandler<AppEnv> = async (c, next) => {
  const identity = c.get(IDENTITY_KEY);
  if (identity.kind === "null") {
    throw new ApiError(
      "forbidden",
      "anonymous (null) users may not perform write operations",
    );
  }
  await next();
};
