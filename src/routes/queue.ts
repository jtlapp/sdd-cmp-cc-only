// GET /queue from PRD §15.2 — calling user's currently-queued changes
// across all proposals, **including those in the invalid–awaiting-dismiss
// sub-state** (§11.4 case 3). Phase 7 makes that sub-state reachable.
//
// Lazy re-evaluation (§11.4 last paragraph, Phase-7 plan decision 2):
// before returning the queue, re-validate every still-queued entry
// against current live state. Anything that broke since the caller's
// last visit transitions to `invalid` (case 3) and stays in the queue.
// This runs inside the §11.1 write lock — it's a state mutation
// triggered by a read.
//
// Auth (initial-plan decision #11 from Phase 5, unchanged):
//   - null caller     → 200, empty list (nothing is ever routed to null)
//   - unregistered    → 403 (the identity gate rejects)
//   - malformed       → 400 (the identity gate rejects)
//   - registered      → 200, the caller's queue

import { Hono } from "hono";

import type { AppEnv } from "../identity.js";
import { IDENTITY_KEY } from "../identity.js";
import { identityWithRegistry } from "../middleware/identity.js";
import {
  getChange,
  queuedChangeIdsFor,
  renderQueueEntry,
} from "../proposals.js";
import { lazyReevaluateExternal } from "../review.js";
import { withWriteLock } from "../writeLock.js";

export const queueRouter = new Hono<AppEnv>();

queueRouter.get("/queue", identityWithRegistry, async (c) => {
  const identity = c.get(IDENTITY_KEY);
  if (identity.kind === "null") {
    return c.json({ changes: [] });
  }

  // Mutating read: case-3 detection is performed lazily here. Take the
  // write lock; build the response while we hold it.
  const reviewer = identity.username;
  const changes = await withWriteLock(() => {
    lazyReevaluateExternal(reviewer);
    // Walk raw queue ids so that case-3 invalid entries (state="invalid"
    // but still queued for dismissal) are included per §15.2.
    const out = [];
    for (const id of queuedChangeIdsFor(reviewer)) {
      const change = getChange(id);
      if (change === undefined) continue;
      // Defensive: only include queued + invalid. Other states (accepted,
      // rejected, latent) should never sit in any queue.
      if (change.state !== "queued" && change.state !== "invalid") continue;
      out.push(renderQueueEntry(change));
    }
    return out;
  });
  return c.json({ changes });
});
