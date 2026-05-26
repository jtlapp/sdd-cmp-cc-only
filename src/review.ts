// Single-decision review loop from PRD §12.1 (accept), §12.3 (reject),
// §11.3 (promotion), §11.4 case 1 (rejection-propagation), §5/§12.1
// (ownership transfer on create-accept), §10.3 (validation scope).
//
// PURE+STATE: the orchestration is here; the actual taxa mutations go
// through the same fixture primitives the §6 direct actions use
// (createTaxonFixture / attachChildFixture / detachChildFixture), and
// the same Phase-3 invariant module validates the candidate state.
// Proposal/change state and per-reviewer queues are mutated via the
// helpers exposed by src/proposals.ts.
//
// This module is called from inside the §11.1 write lock by the route
// layer (src/routes/reviews.ts); we never grab the lock ourselves.
//
// Out of scope for Phase 6 (deferred to Phase 7):
//   - cascade accept (§12.2),
//   - dismiss (§12.4),
//   - self-invalidation auto-dismiss (§11.4 case 2),
//   - external invalidation that stays queued (§11.4 case 3),
//   - lazy validity re-evaluation on /queue reads.

import { evaluateAll, type Violation } from "./invariants.js";
import {
  dequeueChange,
  enqueueChange,
  type Change,
  type ChangeId,
  type PayloadNode,
  type Proposal,
} from "./proposals.js";
import { descendants } from "./reachability.js";
import {
  attachChildFixture,
  createTaxonFixture,
  detachChildFixture,
  getState,
  getTaxon,
  removeTaxonFixture,
} from "./taxa.js";
import type { TaxonId, TaxonState } from "./taxa.js";

// --- Result types ----------------------------------------------------------
//
// The route layer translates these to HTTP status codes via §15.6.

export type ReviewFailure =
  | { kind: "not_found"; message: string }
  | { kind: "forbidden"; message: string }
  | { kind: "conflict"; message: string; details?: Record<string, unknown> };

export type ReviewResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: ReviewFailure };

// --- Accept ----------------------------------------------------------------

export function acceptChange(
  changeId: ChangeId,
  caller: string,
  proposal: Proposal,
  change: Change,
): ReviewResult<{ changeId: ChangeId; state: "accepted" }> {
  // Reviewer + state guards. Resource lookup (404 for unknown id) is the
  // caller's responsibility.
  if (change.reviewer !== caller) {
    return {
      ok: false,
      failure: {
        kind: "forbidden",
        message: `caller ${caller} is not the reviewer of change ${changeId}`,
      },
    };
  }
  if (change.state !== "queued") {
    return {
      ok: false,
      failure: {
        kind: "conflict",
        message: `change ${changeId} is not in queued state (currently ${change.state})`,
        details: { kind: "change_not_queued", changeId, state: change.state },
      },
    };
  }

  // Apply the mutation tentatively, then evaluate §3.3 invariants against
  // the candidate state per §10.3. The candidate state IS the live state
  // after the tentative apply — the same pattern the §6 direct-action
  // handlers use (writesRouter).
  const applied = applyMutation(change, caller);

  const result = evaluateAll(getState());
  if (!result.ok) {
    // Roll back, leave change queued (Phase 6 decision #2 — case-2/3
    // transitions land in Phase 7).
    rollbackMutation(applied);
    return {
      ok: false,
      failure: conflictFromViolations(result.violations, changeId),
    };
  }

  // Commit.
  change.state = "accepted";
  change.liveTaxonId = applied.liveTaxonId;
  dequeueChange(changeId, caller);

  // Promotion (§11.3) — only on add/graft acceptance.
  if (change.op === "add") {
    promoteDirectDependents(proposal, change, caller);
  }

  return { ok: true, value: { changeId, state: "accepted" } };
}

// --- Reject ----------------------------------------------------------------

export function rejectChange(
  changeId: ChangeId,
  caller: string,
  proposal: Proposal,
  change: Change,
): ReviewResult<{ changeId: ChangeId; state: "rejected" }> {
  if (change.reviewer !== caller) {
    return {
      ok: false,
      failure: {
        kind: "forbidden",
        message: `caller ${caller} is not the reviewer of change ${changeId}`,
      },
    };
  }
  if (change.state !== "queued") {
    return {
      ok: false,
      failure: {
        kind: "conflict",
        message: `change ${changeId} is not in queued state (currently ${change.state})`,
        details: { kind: "change_not_queued", changeId, state: change.state },
      },
    };
  }

  change.state = "rejected";
  dequeueChange(changeId, caller);

  // §11.4 case 1: only an add/graft rejection cascades-invalidates
  // payload descendants (decision #1). Rename / detach rejection does
  // not — descendants depend only on the taxon's existence, which a
  // rejected rename does not disturb (and detach has no children).
  if (change.op === "add") {
    invalidatePayloadDescendants(proposal, change, `ancestor ${changeId} was rejected`);
  }

  return { ok: true, value: { changeId, state: "rejected" } };
}

// --- Mutation primitives ---------------------------------------------------
//
// applyMutation tentatively mutates live state for the given change and
// returns a rollback record. rollbackMutation undoes it. The same
// fixture primitives the §6 direct actions use are used here so the
// state shape stays consistent across mutation paths.

interface AppliedMutation {
  readonly change: Change;
  readonly caller: string;
  /** The live taxon id this change refers to after the mutation:
   *   - rename: the renamed taxon (unchanged)
   *   - add-create: the newly-minted id
   *   - add-graft: the grafted taxon (unchanged)
   *   - detach: the detached taxon (unchanged)
   *  Used to set Change.liveTaxonId on success; needed for promotion
   *  (when downstream changes route to a just-created taxon's owner). */
  readonly liveTaxonId: TaxonId | undefined;
  /** Closure capturing the inverse mutation. */
  readonly rollback: () => void;
}

function applyMutation(change: Change, caller: string): AppliedMutation {
  switch (change.op) {
    case "rename": {
      const taxonId = change.taxonId as TaxonId;
      const t = getTaxon(taxonId);
      // Existence is guaranteed by submission-time checks + Phase 6
      // promotion's existence-dep check; defensive check anyway.
      if (t === undefined) {
        throw new Error(`rename: taxon ${taxonId} disappeared between submission and accept`);
      }
      const oldName = t.name;
      const newName = change.name as string;
      t.name = newName;
      return {
        change,
        caller,
        liveTaxonId: taxonId,
        rollback: () => {
          t.name = oldName;
        },
      };
    }
    case "add": {
      const parentId = change.payloadParentTaxonId as TaxonId;
      if (change.taxonId === undefined) {
        // create
        const created = createTaxonFixture(change.name as string, caller);
        attachChildFixture(parentId, created.id);
        return {
          change,
          caller,
          liveTaxonId: created.id,
          rollback: () => {
            // Undo the edge first, then drop the freshly-created taxon
            // entirely. removeTaxonFixture also cleans up its parent
            // index entry, so this is the cleanest reversal.
            detachChildFixture(parentId, created.id);
            removeTaxonFixture(created.id);
          },
        };
      } else {
        // graft
        const childId = change.taxonId;
        attachChildFixture(parentId, childId);
        return {
          change,
          caller,
          liveTaxonId: childId,
          rollback: () => {
            detachChildFixture(parentId, childId);
          },
        };
      }
    }
    case "detach": {
      const parentId = change.payloadParentTaxonId as TaxonId;
      const childId = change.taxonId as TaxonId;
      // Only detach if the edge currently exists; otherwise the change
      // wouldn't validate (existence dep), which the invariant check
      // will catch after this is a no-op.
      const parent = getTaxon(parentId);
      const hadEdge = parent !== undefined && parent.childIds.has(childId);
      if (hadEdge) {
        detachChildFixture(parentId, childId);
      }
      return {
        change,
        caller,
        liveTaxonId: childId,
        rollback: () => {
          if (hadEdge) attachChildFixture(parentId, childId);
        },
      };
    }
  }
}

function rollbackMutation(applied: AppliedMutation): void {
  applied.rollback();
}

// --- Promotion (§11.3) -----------------------------------------------------
//
// When add/graft A is accepted, its DIRECT dependents are the changes
// whose nearestAddAncestorChangeId === A.id. For each, resolve the
// reviewer at promotion time and enqueue — unless the change's
// existence deps have broken, in which case mark it invalid.

function promoteDirectDependents(
  proposal: Proposal,
  acceptedAdd: Change,
  acceptingReviewer: string,
): void {
  for (const c of proposal.changes.values()) {
    if (c.nearestAddAncestorChangeId !== acceptedAdd.id) continue;
    if (c.state !== "latent") continue; // already promoted/rejected/invalid

    // For an add or detach whose payload-parent is the just-accepted
    // add-create, patch in the live id of the new parent. (For
    // add-graft, payloadParentTaxonId was already known at submission;
    // for an add-create parent, it was undefined.)
    if (
      (c.op === "add" || c.op === "detach") &&
      c.payloadParentTaxonId === undefined &&
      acceptedAdd.liveTaxonId !== undefined
    ) {
      // Only patch when the payload-parent of THIS dependent is the
      // accepted add itself — i.e. the dependent is a direct payload
      // child of the accepted add. Detected by checking c's path ends
      // with [..., acceptedAdd, c].
      const acceptedAddInternal = acceptedAdd.payloadPath[acceptedAdd.payloadPath.length - 1];
      if (c.payloadPath.length >= 2 && c.payloadPath[c.payloadPath.length - 2] === acceptedAddInternal) {
        c.payloadParentTaxonId = acceptedAdd.liveTaxonId;
      }
    }

    // Existence-dep check (§11.3 "provided their existence dependencies
    // also currently hold"). Invalidates the dependent if a no-op /
    // rename ancestor's payload position is broken in live state.
    const dep = checkExistenceDeps(c, proposal, getState());
    if (!dep.ok) {
      c.state = "invalid";
      c.reason = `existence dependency ${dep.missing} is no longer in target tree`;
      continue;
    }

    // Resolve reviewer at promotion time.
    const reviewer = resolveReviewerAtPromotion(c, acceptingReviewer);
    if (reviewer === null) {
      // Could not resolve a reviewer — treat as existence-dep failure.
      // Shouldn't reach here in normal Phase-6 flows given the path
      // patching above, but defensive.
      c.state = "invalid";
      c.reason = `could not resolve reviewer at promotion`;
      continue;
    }
    c.reviewer = reviewer;
    c.state = "queued";
    enqueueChange(c.id, reviewer);
  }
}

/** Pick the reviewer for a promoted change. For renames the reviewer was
 *  already recorded at submission (renamed-taxon's owner). For add /
 *  detach, the payload-parent owner — possibly the just-created taxon
 *  whose owner is the accepting reviewer. */
function resolveReviewerAtPromotion(
  change: Change,
  acceptingReviewer: string,
): string | null {
  if (change.op === "rename") {
    // Submission already captured this; nothing changes on promotion.
    return change.reviewer;
  }
  // add / detach: payload-parent owner.
  const parentId = change.payloadParentTaxonId;
  if (parentId === undefined) {
    // Parent was an add-create, but we couldn't patch the live id —
    // means the change is not a *direct* child of the accepted add (so
    // its own decision-dep ancestor must be a different add we haven't
    // accepted yet). promoteDirectDependents already filters by
    // nearestAddAncestorChangeId, so this is unreachable in practice.
    return acceptingReviewer;
  }
  const t = getTaxon(parentId);
  return t === undefined ? null : t.owner;
}

// --- Existence-dep check at promotion --------------------------------------
//
// For each ancestor of `change` on the payload path that is a no-op or
// rename, verify it currently sits at the position the payload claims
// (i.e. its live id is a child of the next-higher ancestor's live id;
// and the topmost ancestor lies within the target tree). Returns the
// first broken link if any.

interface ExistenceDepFailure {
  ok: false;
  missing: TaxonId;
}
interface ExistenceDepOk {
  ok: true;
}
type ExistenceDepResult = ExistenceDepOk | ExistenceDepFailure;

function checkExistenceDeps(
  change: Change,
  proposal: Proposal,
  state: TaxonState,
): ExistenceDepResult {
  // Build the live-id ancestor chain (top → parent-of-change). An
  // ancestor that is an add-create gets its liveTaxonId (set on
  // acceptance). An ancestor that is a no-op, rename, or add-graft
  // uses its payload id directly. An ancestor that is an add-create
  // but isn't yet accepted couldn't be on this change's path —
  // promotion only fires once the nearest add is accepted, but a
  // higher unaccepted add would mean THIS change isn't directly
  // promoted yet. (We are called only with state==="latent" and
  // nearestAddAncestorChangeId === acceptedAdd.id, so any higher add
  // on the path is the accepting one; all *other* add-ancestors above
  // that are also accepted by transitivity of how we got here.)

  const liveAncestorIds: TaxonId[] = [];
  // payloadPath includes the change itself at the end; ancestors are
  // path[0..length-2].
  for (let i = 0; i < change.payloadPath.length - 1; i++) {
    const node = proposal.nodesByInternalId.get(change.payloadPath[i]);
    if (node === undefined) {
      // Should not happen — bookkeeping bug.
      throw new Error(`payload node ${change.payloadPath[i]} missing from proposal ${proposal.id}`);
    }
    let liveId: TaxonId | undefined;
    if (node.id !== null) {
      liveId = node.id;
    } else {
      // add-create payload taxon. Find its change to read liveTaxonId.
      const ancestorChange = node.changeId !== undefined
        ? proposal.changes.get(node.changeId)
        : undefined;
      liveId = ancestorChange?.liveTaxonId;
    }
    if (liveId === undefined) {
      // An ancestor we can't resolve — treat as broken.
      return { ok: false, missing: change.payloadPath[i] as TaxonId };
    }
    liveAncestorIds.push(liveId);
  }

  if (liveAncestorIds.length === 0) {
    // Change is at top; no ancestor chain to verify.
    return { ok: true };
  }

  // Top of chain: must be in the target tree.
  const top = liveAncestorIds[0];
  if (!isInTree(top, proposal.targetRootId, state)) {
    return { ok: false, missing: top };
  }

  // Each consecutive pair must have parent→child edge in live state.
  for (let i = 1; i < liveAncestorIds.length; i++) {
    const parentId = liveAncestorIds[i - 1];
    const childId = liveAncestorIds[i];
    const parent = state.taxa.get(parentId);
    if (parent === undefined || !parent.childIds.has(childId)) {
      return { ok: false, missing: childId };
    }
  }

  return { ok: true };
}

function isInTree(
  taxonId: TaxonId,
  rootId: TaxonId,
  state: TaxonState,
): boolean {
  if (taxonId === rootId) return true;
  const desc = descendants(rootId, state);
  return desc.includes(taxonId);
}

// --- Rejection-propagation (§11.4 case 1) ---------------------------------

function invalidatePayloadDescendants(
  proposal: Proposal,
  rejected: Change,
  reason: string,
): void {
  // A change is a payload-descendant of `rejected` iff `rejected.id` is
  // on its payloadPath (not counting itself). The payloadPath includes
  // internalIds; the rejected change's internalId is the last element
  // of its own payloadPath.
  const rejectedInternal = rejected.payloadPath[rejected.payloadPath.length - 1];

  for (const c of proposal.changes.values()) {
    if (c.id === rejected.id) continue;
    if (c.state === "accepted" || c.state === "rejected" || c.state === "invalid") continue;
    // Ancestors only; if rejectedInternal is in c's path (excluding the
    // tail self), c is a descendant of rejected.
    const isDescendant = c.payloadPath.slice(0, -1).includes(rejectedInternal);
    if (!isDescendant) continue;

    if (c.state === "queued" && c.reviewer !== null) {
      dequeueChange(c.id, c.reviewer);
    }
    c.state = "invalid";
    c.reason = reason;
  }
}

// --- Violation → conflict envelope ----------------------------------------

function conflictFromViolations(
  violations: Violation[],
  changeId: ChangeId,
): ReviewFailure {
  // Mirrors writes.ts conflictFromViolation but worded for the accept
  // path so the client knows which change was being accepted.
  const v = violations[0];
  switch (v.kind) {
    case "cycle":
      return {
        kind: "conflict",
        message: `accept ${changeId}: would create a cycle through [${v.taxa.join(", ")}]`,
        details: { kind: "cycle", taxa: v.taxa },
      };
    case "in_tree_duplicate":
      return {
        kind: "conflict",
        message: `accept ${changeId}: taxon ${v.taxonId} would be reachable by more than one path in tree ${v.rootId}`,
        details: {
          kind: "in_tree_duplicate",
          rootId: v.rootId,
          taxonId: v.taxonId,
        },
      };
    case "name_clash":
      return {
        kind: "conflict",
        message: `accept ${changeId}: name "${v.name}" clashes within tree ${v.rootId} between [${v.taxa.join(", ")}]`,
        details: {
          kind: "name_clash",
          rootId: v.rootId,
          name: v.name,
          taxa: v.taxa,
        },
      };
  }
}
