import { Hono } from "hono";

import { ApiError, errorBody, httpError, STATUS_BY_CODE } from "./errors.js";
import type { AppEnv } from "./identity.js";
import { identityWithRegistry } from "./middleware/identity.js";
import { usersRouter } from "./routes/users.js";
import { resetAllState } from "./state.js";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Trivial liveness probe — proves the server boots and routes (phase-1
  // brief). §4 identity gate applies (malformed X-Username still 400s per
  // decision #2); null and registered callers may probe it.
  app.get("/health", identityWithRegistry, (c) => c.json({ status: "ok" }));

  // §15: fresh-boot state reset. Exempt from §4 — callable by null,
  // unregistered, AND malformed-header callers. Plug-in cleanups live in
  // state.ts (the registry registers its clear() there).
  app.post("/reset", (c) => {
    resetAllState();
    return c.body(null, 204);
  });

  // §15.1 user registry. Per-route middleware lives inside usersRouter.
  app.route("/", usersRouter);

  app.notFound((c) =>
    httpError(c, "not_found", `no route matches ${c.req.method} ${new URL(c.req.url).pathname}`),
  );

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(errorBody(err.code, err.message, err.details), STATUS_BY_CODE[err.code]);
    }
    // Unhandled exception — not a documented §15.6 code. Use the same
    // envelope shape so clients always parse the same way.
    return c.json(
      { error: { code: "internal_error", message: "internal server error" } },
      500,
    );
  });

  return app;
}
