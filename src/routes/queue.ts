// GET /queue from PRD §15.2 — calling user's currently queued changes
// across all proposals. In Phase 5 only the "queued" state is reachable;
// the §15.2 "including invalid–awaiting-dismiss" sub-state is unreachable
// until Phase 7 introduces external invalidation.
//
// Auth (initial-plan decision #11):
//   - null caller     → 200, empty list (nothing is ever routed to null)
//   - unregistered    → 403 (the identity gate rejects)
//   - malformed       → 400 (the identity gate rejects)
//   - registered      → 200, the caller's queue

import { Hono } from "hono";

import type { AppEnv } from "../identity.js";
import { IDENTITY_KEY } from "../identity.js";
import { identityWithRegistry } from "../middleware/identity.js";
import { queuedChangesFor, renderQueueEntry } from "../proposals.js";

export const queueRouter = new Hono<AppEnv>();

queueRouter.get("/queue", identityWithRegistry, (c) => {
  const identity = c.get(IDENTITY_KEY);
  if (identity.kind === "null") {
    return c.json({ changes: [] });
  }
  const changes = queuedChangesFor(identity.username).map(renderQueueEntry);
  return c.json({ changes });
});
