// Review-action routes from PRD §15.5.
//
//   POST /changes/{id}/accept           — §12.1 single accept
//   POST /changes/{id}/accept-cascade   — §12.2 atomic cascade (errata E1)
//   POST /changes/{id}/reject           — §12.3 reject
//   POST /changes/{id}/dismiss          — §12.4 dismiss
//
// All run under the §11.1 write lock and the Phase-2
// identityWithRegistry + requireWriter chain. Failure mapping per §15.6.
//
// Lazy re-evaluation (§11.4 case 3, Phase-7 plan decision 2): on entry
// to any review action, we re-validate the caller's queued changes
// against current live state. Anything that broke since the caller's
// last visit transitions to `invalid` (case 3, kept in queue). The
// specific change the call targets is then looked up; if the lazy pass
// has just flipped it to `invalid`, the existing not-queued guard
// catches it.

import { Hono } from "hono";

import { ApiError } from "../errors.js";
import type { AppEnv, Identity } from "../identity.js";
import { IDENTITY_KEY } from "../identity.js";
import { identityWithRegistry } from "../middleware/identity.js";
import { requireWriter } from "../middleware/requireWriter.js";
import {
  getChange,
  getProposal,
  type Change,
  type ChangeId,
  type Proposal,
} from "../proposals.js";
import {
  acceptCascade,
  acceptChange,
  dismissChange,
  lazyReevaluateExternal,
  rejectChange,
  type ReviewFailure,
  type ReviewResult,
} from "../review.js";
import { withWriteLock } from "../writeLock.js";

export const reviewsRouter = new Hono<AppEnv>();

const writerGates = [identityWithRegistry, requireWriter] as const;

function callerCanonical(identity: Identity): string {
  if (identity.kind !== "registered") {
    throw new ApiError(
      "forbidden",
      "writer middleware did not resolve a registered identity",
    );
  }
  return identity.username;
}

function failureToApiError(f: ReviewFailure): ApiError {
  switch (f.kind) {
    case "not_found":
      return new ApiError("not_found", f.message);
    case "forbidden":
      return new ApiError("forbidden", f.message);
    case "conflict":
      return new ApiError("conflict", f.message, f.details);
  }
}

type ReviewAction<T> = (
  changeId: ChangeId,
  caller: string,
  proposal: Proposal,
  change: Change,
) => ReviewResult<T>;

async function runReviewAction<T>(
  changeId: ChangeId,
  caller: string,
  action: ReviewAction<T>,
): Promise<T> {
  const result = await withWriteLock(() => {
    // Lazy re-evaluation (§11.4 case 3) before any action. Skip the
    // targeted change so the action's own validation can decide
    // case-2 vs case-3 for it (Phase-7 plan decisions 1, 7) and
    // surface the underlying violation detail in the conflict.
    lazyReevaluateExternal(caller, changeId);

    const change = getChange(changeId);
    if (change === undefined) {
      return {
        ok: false as const,
        failure: {
          kind: "not_found" as const,
          message: `no such change: ${changeId}`,
        },
      };
    }
    const proposal = getProposal(change.proposalId);
    if (proposal === undefined) {
      return {
        ok: false as const,
        failure: {
          kind: "not_found" as const,
          message: `no such proposal for change: ${changeId}`,
        },
      };
    }
    return action(changeId, caller, proposal, change);
  });

  if (!result.ok) throw failureToApiError(result.failure);
  return result.value;
}

// Dismiss takes (changeId, caller, change) — no proposal lookup needed.
// We still run inside the lock + lazy pass; route adapter below.
async function runDismiss(
  changeId: ChangeId,
  caller: string,
): Promise<{ changeId: ChangeId; state: "invalid"; dismissed: true }> {
  const result = await withWriteLock(() => {
    // Dismiss targets an already-invalid change; lazy re-eval might
    // shuffle other queued ones but doesn't affect a change that's
    // already invalid. Run it for symmetry with other actions; skip
    // the targeted change for the same reason as accept/reject.
    lazyReevaluateExternal(caller, changeId);
    const change = getChange(changeId);
    if (change === undefined) {
      return {
        ok: false as const,
        failure: {
          kind: "not_found" as const,
          message: `no such change: ${changeId}`,
        },
      };
    }
    return dismissChange(changeId, caller, change);
  });
  if (!result.ok) throw failureToApiError(result.failure);
  return result.value;
}

reviewsRouter.post("/changes/:id/accept", ...writerGates, async (c) => {
  const changeId = c.req.param("id");
  const caller = callerCanonical(c.get(IDENTITY_KEY));
  const value = await runReviewAction(changeId, caller, acceptChange);
  return c.json(value);
});

reviewsRouter.post("/changes/:id/accept-cascade", ...writerGates, async (c) => {
  const changeId = c.req.param("id");
  const caller = callerCanonical(c.get(IDENTITY_KEY));
  const value = await runReviewAction(changeId, caller, acceptCascade);
  return c.json(value);
});

reviewsRouter.post("/changes/:id/reject", ...writerGates, async (c) => {
  const changeId = c.req.param("id");
  const caller = callerCanonical(c.get(IDENTITY_KEY));
  const value = await runReviewAction(changeId, caller, rejectChange);
  return c.json(value);
});

reviewsRouter.post("/changes/:id/dismiss", ...writerGates, async (c) => {
  const changeId = c.req.param("id");
  const caller = callerCanonical(c.get(IDENTITY_KEY));
  const value = await runDismiss(changeId, caller);
  return c.json(value);
});
