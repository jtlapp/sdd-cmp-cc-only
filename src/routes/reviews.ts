// Review-action routes from PRD §15.5.
//
//   POST /changes/{id}/accept   — §12.1 single accept
//   POST /changes/{id}/reject   — §12.3 reject
//
// Both run under the §11.1 write lock and the Phase-2
// identityWithRegistry + requireWriter chain. Failure mapping per §15.6:
//   change id unknown      → 404 not_found
//   caller ≠ reviewer      → 403 forbidden
//   change not queued      → 409 conflict
//   accept-time violation  → 409 conflict (change stays queued — Phase 7
//                            replaces this with §11.4 case 2/3 handling)

import { Hono } from "hono";

import { ApiError } from "../errors.js";
import type { AppEnv, Identity } from "../identity.js";
import { IDENTITY_KEY } from "../identity.js";
import { identityWithRegistry } from "../middleware/identity.js";
import { requireWriter } from "../middleware/requireWriter.js";
import {
  getChange,
  getProposal,
  type ChangeId,
} from "../proposals.js";
import {
  acceptChange,
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

// Shared lookup + lock pattern. Returns the parsed result inside the
// lock so we can publish it after release.
async function runReviewAction<T>(
  changeId: ChangeId,
  caller: string,
  action: (
    changeId: ChangeId,
    caller: string,
    proposal: Parameters<typeof acceptChange>[2],
    change: Parameters<typeof acceptChange>[3],
  ) => ReviewResult<T>,
): Promise<T> {
  const result = await withWriteLock(() => {
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
      // Bookkeeping bug — every change should belong to a known
      // proposal. Surface a 404 anyway so the client gets a clean
      // response.
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

reviewsRouter.post("/changes/:id/accept", ...writerGates, async (c) => {
  const changeId = c.req.param("id");
  const caller = callerCanonical(c.get(IDENTITY_KEY));
  const value = await runReviewAction(changeId, caller, acceptChange);
  return c.json(value);
});

reviewsRouter.post("/changes/:id/reject", ...writerGates, async (c) => {
  const changeId = c.req.param("id");
  const caller = callerCanonical(c.get(IDENTITY_KEY));
  const value = await runReviewAction(changeId, caller, rejectChange);
  return c.json(value);
});
