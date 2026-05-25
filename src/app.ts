import { Hono } from "hono";
import { ApiError, errorBody, httpError, STATUS_BY_CODE } from "./errors.js";
import { resetAllState } from "./state.js";

export function createApp(): Hono {
  const app = new Hono();

  // Trivial liveness probe — proves the server boots and routes (phase-1 brief).
  app.get("/health", (c) => c.json({ status: "ok" }));

  // §15: fresh-boot state reset. Exempt from §4 — callable by null and
  // unregistered users; phase 1 has nothing to clear, later phases plug into
  // resetAllState().
  app.post("/reset", (c) => {
    resetAllState();
    return c.body(null, 204);
  });

  app.notFound((c) =>
    httpError(c, "not_found", `no route matches ${c.req.method} ${new URL(c.req.url).pathname}`),
  );

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(errorBody(err.code, err.message, err.details), STATUS_BY_CODE[err.code]);
    }
    // Unhandled exception — not a documented §15.6 code. Use the same envelope
    // shape so clients always parse the same way.
    return c.json(
      { error: { code: "internal_error", message: "internal server error" } },
      500,
    );
  });

  return app;
}
