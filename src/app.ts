import { Hono } from "hono";

import { ApiError, errorBody, httpError, STATUS_BY_CODE } from "./errors.js";
import type { AppEnv } from "./identity.js";
import { identityWithRegistry } from "./middleware/identity.js";
import { proposalsRouter } from "./routes/proposals.js";
import { queueRouter } from "./routes/queue.js";
import { readsRouter } from "./routes/reads.js";
import { usersRouter } from "./routes/users.js";
import { writesRouter } from "./routes/writes.js";
import { resetAllState } from "./state.js";
import { withWriteLock } from "./writeLock.js";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Trivial liveness probe — proves the server boots and routes (phase-1
  // brief). §4 identity gate applies (malformed X-Username still 400s per
  // decision #2); null and registered callers may probe it.
  app.get("/health", identityWithRegistry, (c) => c.json({ status: "ok" }));

  // §15: fresh-boot state reset. Exempt from §4 — callable by null,
  // unregistered, AND malformed-header callers. Plug-in cleanups live in
  // state.ts (the registry registers its clear() there).
  //
  // §15 also says reset "runs under the §11.1 write serialization", so we
  // route it through the same write lock as every Phase-4 mutation.
  app.post("/reset", async (c) => {
    await withWriteLock(() => resetAllState());
    return c.body(null, 204);
  });

  // §15.1 user registry. Per-route middleware lives inside usersRouter.
  app.route("/", usersRouter);

  // §15.2 domain reads (taxa + trees). Identity gate applied inside the
  // sub-router; null users may read per §15.2.
  app.route("/", readsRouter);

  // §15.3 direct actions (create / edit / delete / edge add / detach). All
  // gates and the write lock live inside the sub-router.
  app.route("/", writesRouter);

  // §15.4 proposal submission + §15.2 proposal reads. Identity gates and
  // the write lock live inside the sub-router.
  app.route("/", proposalsRouter);

  // §15.2 GET /queue — caller's currently queued changes.
  app.route("/", queueRouter);

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
