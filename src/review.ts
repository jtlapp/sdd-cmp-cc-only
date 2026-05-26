// Review loop from PRD §12 + §11.4. Builds on the Phase-6 single-review
// baseline by adding:
//
//   - cascade accept (§12.2) with atomic rollback (errata E1)
//   - the case-2 (self) and case-3 (external) invalidation modes from
//     §11.4, with lazy evaluation on the read/entry seams
//   - dismiss (§12.4)
//
// Authoritative reads: prd/prd.md §11.3, §11.4, §12.1–§12.4, §15.5,
// plus prd/prd-errata.md E1.
//
// PURE+STATE: orchestration here. The actual taxa mutations go through
// the same fixture primitives the §6 direct actions use; invariants
// from src/invariants.ts decide validity. We never grab the §11.1 write
// lock from inside this module — the route layer wraps the call.
//
// Invalidation labels (per Phase-7 plan decisions 1, 10):
//
//   case 1 — dependency failure (ancestor add/graft rejected OR became
//            invalid): payload descendants become `invalid`,
//            reason = `ancestor <id> was rejected | became invalid`
//   case 2 — self-invalidation by the reviewer's own action:
//            auto-dismissed (invalid, dequeued),
//            reason = `self-invalidated by <trigger>`
//   case 3 — external invalidation (anyone else's action):
//            marked invalid, kept in queue (awaiting dismiss),
//            reason = `externally invalidated`
//
// Eager vs lazy (Phase-7 plan decision 2):
//
//   case 2 detection runs eagerly at the end of every accept / cascade
//   / reject call by the acting reviewer, AND on a failed single-accept
//   (replacing the Phase-6 "stays queued" placeholder).
//
//   case 3 detection runs lazily — on `GET /queue` reads and on entry
//   to a review action — by re-validating the reviewer's queued changes
//   against current live state. No global re-validation pass after an
//   unrelated write.

import { evaluateAll, type Violation } from "./invariants.js";
import {
  dequeueChange,
  enqueueChange,
  enqueueChangeAt,
  getChange,
  getProposal,
  indexInQueue,
  queuedChangesFor,
  type Change,
  type ChangeId,
  type ChangeState,
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

export type ReviewFailure =
  | { kind: "not_found"; message: string }
  | { kind: "forbidden"; message: string }
  | { kind: "conflict"; message: string; details?: Record<string, unknown> };

export type ReviewResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: ReviewFailure };

// --- Cascade audit ---------------------------------------------------------
//
// During a cascade we record every state-touching effect so that any
// constituent failure can roll back to byte-equal pre-call state. Two
// effect kinds: live-state mutations (taxa/edges) and Change-record
// transitions (state, reviewer, queue membership, etc.).

interface ChangeSnapshot {
  readonly state: ChangeState;
  readonly reviewer: string | null;
  readonly payloadParentTaxonId: TaxonId | undefined;
  readonly reason: string | undefined;
  readonly liveTaxonId: TaxonId | undefined;
  /** Index in `queueReviewer`'s queue, or -1 if not in any queue. */
  readonly queueIndex: number;
  /** The reviewer whose queue this change was in, or null. */
  readonly queueReviewer: string | null;
}

interface CascadeAudit {
  /** Per-change snapshot recorded the FIRST time the cascade mutates
   *  the change. Later mutations don't overwrite — rollback restores to
   *  the earliest pre-cascade snapshot. */
  readonly snapshots: Map<ChangeId, ChangeSnapshot>;
  /** Live-state rollback closures, in apply order. Walked in reverse. */
  readonly liveRollbacks: Array<() => void>;
}

function freshAudit(): CascadeAudit {
  return { snapshots: new Map(), liveRollbacks: [] };
}

function snapshotIfNew(audit: CascadeAudit, change: Change): void {
  if (audit.snapshots.has(change.id)) return;
  // Determine which reviewer's queue the change is currently in, if any.
  let queueReviewer: string | null = null;
  let queueIndex = -1;
  if (change.reviewer !== null) {
    const idx = indexInQueue(change.id, change.reviewer);
    if (idx >= 0) {
      queueReviewer = change.reviewer;
      queueIndex = idx;
    }
  }
  audit.snapshots.set(change.id, {
    state: change.state,
    reviewer: change.reviewer,
    payloadParentTaxonId: change.payloadParentTaxonId,
    reason: change.reason,
    liveTaxonId: change.liveTaxonId,
    queueIndex,
    queueReviewer,
  });
}

function rollbackAudit(audit: CascadeAudit): void {
  // 1. Undo live-state mutations in reverse order.
  for (let i = audit.liveRollbacks.length - 1; i >= 0; i--) {
    audit.liveRollbacks[i]();
  }
  // 2. Restore every snapshotted Change record.
  for (const [changeId, snap] of audit.snapshots) {
    const change = getChangeRecord(changeId);
    if (change === undefined) continue;
    // Remove from any queue it currently sits in (could be different
    // from the snapshotted one — promotion may have enqueued it
    // elsewhere mid-cascade).
    if (change.reviewer !== null) {
      dequeueChange(change.id, change.reviewer);
    }
    // Restore fields.
    change.state = snap.state;
    change.reviewer = snap.reviewer;
    change.payloadParentTaxonId = snap.payloadParentTaxonId;
    if (snap.reason === undefined) {
      delete (change as { reason?: string }).reason;
    } else {
      change.reason = snap.reason;
    }
    if (snap.liveTaxonId === undefined) {
      delete (change as { liveTaxonId?: TaxonId }).liveTaxonId;
    } else {
      change.liveTaxonId = snap.liveTaxonId;
    }
    // Restore queue membership at original position.
    if (snap.queueReviewer !== null) {
      enqueueChangeAt(change.id, snap.queueReviewer, snap.queueIndex);
    }
  }
}

function getChangeRecord(changeId: ChangeId): Change | undefined {
  return getChange(changeId);
}

// --- Single accept (§12.1) -------------------------------------------------

export function acceptChange(
  changeId: ChangeId,
  caller: string,
  proposal: Proposal,
  change: Change,
): ReviewResult<{ changeId: ChangeId; state: "accepted" }> {
  if (change.reviewer !== caller) {
    return forbidden(`caller ${caller} is not the reviewer of change ${changeId}`);
  }
  if (change.state !== "queued") {
    return notQueued(changeId, change.state);
  }

  const applied = applyMutation(change, caller);
  const result = evaluateAll(getState());
  if (!result.ok) {
    rollbackMutation(applied);
    // §11.4 case 2 — auto-dismiss; replaces Phase-6 placeholder.
    selfInvalidate(change, `self-invalidated by your accept of ${changeId}`);
    if (change.op === "add") {
      invalidatePayloadDescendants(
        proposal,
        change,
        `ancestor ${changeId} became invalid`,
        /*audit=*/ undefined,
      );
    }
    return {
      ok: false,
      failure: conflictFromViolations(result.violations, changeId),
    };
  }

  change.state = "accepted";
  change.liveTaxonId = applied.liveTaxonId;
  dequeueChange(changeId, caller);

  if (change.op === "add") {
    promoteDirectDependents(proposal, change, caller, /*audit=*/ undefined);
  }

  // §11.4 case 2 pass — anything else of this reviewer's that broke as
  // a consequence of this accept auto-dismisses.
  revalidateReviewerQueueForSelf(caller, `your accept of ${changeId}`);

  return { ok: true, value: { changeId, state: "accepted" } };
}

// --- Cascade accept (§12.2 + errata E1) ------------------------------------

export function acceptCascade(
  seedChangeId: ChangeId,
  caller: string,
  proposal: Proposal,
  seedChange: Change,
): ReviewResult<{ rootChangeId: ChangeId; acceptedChangeIds: ChangeId[] }> {
  if (seedChange.reviewer !== caller) {
    return forbidden(`caller ${caller} is not the reviewer of change ${seedChangeId}`);
  }
  if (seedChange.state !== "queued") {
    return notQueued(seedChangeId, seedChange.state);
  }

  const audit = freshAudit();
  const accepted: ChangeId[] = [];
  const worklist: Change[] = [seedChange];

  while (worklist.length > 0) {
    const next = worklist.shift() as Change;

    // Cascade boundary: this reviewer's currently-queued changes only.
    // (A change can fall off the cascade if a prior step in this same
    // cascade case-1-invalidated it via propagation through an
    // ancestor — that's intended; just skip it.)
    if (next.state !== "queued") continue;
    if (next.reviewer !== caller) continue;

    // Snapshot before mutation.
    snapshotIfNew(audit, next);

    const applied = applyMutation(next, caller);
    audit.liveRollbacks.push(applied.rollback);

    const result = evaluateAll(getState());
    if (!result.ok) {
      rollbackAudit(audit);
      return {
        ok: false,
        failure: cascadeRollbackFailure(
          seedChangeId,
          next.id,
          result.violations,
        ),
      };
    }

    // Commit this step's Change bookkeeping.
    next.state = "accepted";
    next.liveTaxonId = applied.liveTaxonId;
    dequeueChange(next.id, caller);

    accepted.push(next.id);

    if (next.op === "add") {
      const promoted = promoteDirectDependents(
        proposal,
        next,
        caller,
        audit,
      );
      for (const p of promoted) {
        if (
          p.state === "queued" &&
          p.reviewer === caller
        ) {
          worklist.push(p);
        }
      }
    }
  }

  // Cascade complete. §11.4 case-2 pass.
  revalidateReviewerQueueForSelf(
    caller,
    `your accept-cascade rooted at ${seedChangeId}`,
  );

  return {
    ok: true,
    value: { rootChangeId: seedChangeId, acceptedChangeIds: accepted },
  };
}

// --- Reject (§12.3) --------------------------------------------------------

export function rejectChange(
  changeId: ChangeId,
  caller: string,
  proposal: Proposal,
  change: Change,
): ReviewResult<{ changeId: ChangeId; state: "rejected" }> {
  if (change.reviewer !== caller) {
    return forbidden(`caller ${caller} is not the reviewer of change ${changeId}`);
  }
  if (change.state !== "queued") {
    return notQueued(changeId, change.state);
  }

  change.state = "rejected";
  dequeueChange(changeId, caller);

  if (change.op === "add") {
    invalidatePayloadDescendants(
      proposal,
      change,
      `ancestor ${changeId} was rejected`,
      /*audit=*/ undefined,
    );
  }

  // §11.4 case-2 pass: a reject doesn't mutate live state, so it can
  // only break a queued change via case-1 propagation already handled
  // above. Pass kept for symmetry; effectively a no-op here.
  revalidateReviewerQueueForSelf(caller, `your reject of ${changeId}`);

  return { ok: true, value: { changeId, state: "rejected" } };
}

// --- Dismiss (§12.4) -------------------------------------------------------

export function dismissChange(
  changeId: ChangeId,
  caller: string,
  change: Change,
): ReviewResult<{ changeId: ChangeId; state: "invalid"; dismissed: true }> {
  // Authorization: if the change has a known reviewer, the caller must
  // match. A latent change that became case-1 invalid never had a
  // reviewer (reviewer remains null); in that case skip the auth check
  // and let the state/queue checks below decide.
  if (change.reviewer !== null && change.reviewer !== caller) {
    return forbidden(
      `caller ${caller} is not the reviewer of change ${changeId}`,
    );
  }
  // State precondition: dismiss only applies to invalid changes.
  if (change.state !== "invalid") {
    return {
      ok: false,
      failure: {
        kind: "conflict",
        message: `change ${changeId} is not in invalid state (currently ${change.state})`,
        details: { kind: "change_not_invalid", changeId, state: change.state },
      },
    };
  }
  // Queue precondition: only case-3 invalids (in the queue) are
  // dismissable. case-1 (never queued) and case-2 (auto-dismissed) are
  // not.
  if (indexInQueue(changeId, caller) < 0) {
    return {
      ok: false,
      failure: {
        kind: "conflict",
        message: `change ${changeId} is invalid but not in your queue (case-1 or case-2)`,
        details: { kind: "change_not_in_queue", changeId, state: change.state },
      },
    };
  }

  dequeueChange(changeId, caller);
  return {
    ok: true,
    value: { changeId, state: "invalid", dismissed: true },
  };
}

// --- Lazy evaluation seam (§11.4 case 3) -----------------------------------
//
// Called by /queue reads and review-action entry. Walks every change
// currently sitting in `reviewer`'s queue; for each one still in state
// `queued`, trial-applies it and checks invariants. Any failure
// transitions the change to `invalid` (case 3) and keeps it in the
// queue. Side-effecting; must run inside the §11.1 write lock.

export function lazyReevaluateExternal(
  reviewer: string,
  skipChangeId?: ChangeId,
): void {
  const candidates = queuedChangesFor(reviewer);
  for (const c of candidates) {
    if (c.state !== "queued") continue;
    // At review-action entry, callers pass the targeted change id here
    // so the action's own validation can decide case-2 vs case-3 for
    // it (plan decisions 1 + 7). Skipping the targeted change keeps
    // the conflict response shape informative — the action surfaces
    // the underlying violation details instead of `change_not_queued`.
    if (c.id === skipChangeId) continue;
    if (validatesAgainstLive(c)) continue;
    c.state = "invalid";
    c.reason = "externally invalidated";
    if (c.op === "add") {
      const proposal = getProposal(c.proposalId);
      if (proposal !== undefined) {
        invalidatePayloadDescendants(
          proposal,
          c,
          `ancestor ${c.id} became invalid`,
          /*audit=*/ undefined,
        );
      }
    }
  }
}

function revalidateReviewerQueueForSelf(
  reviewer: string,
  trigger: string,
): void {
  // Snapshot the queue before iterating — selfInvalidate below mutates
  // queue membership.
  const candidates = [...queuedChangesFor(reviewer)];
  for (const c of candidates) {
    if (c.state !== "queued") continue;
    if (validatesAgainstLive(c)) continue;
    selfInvalidate(c, `self-invalidated by ${trigger}`);
    if (c.op === "add") {
      const proposal = getProposal(c.proposalId);
      if (proposal !== undefined) {
        invalidatePayloadDescendants(
          proposal,
          c,
          `ancestor ${c.id} became invalid`,
          /*audit=*/ undefined,
        );
      }
    }
  }
}

function selfInvalidate(change: Change, reason: string): void {
  if (change.state === "queued" && change.reviewer !== null) {
    dequeueChange(change.id, change.reviewer);
  }
  change.state = "invalid";
  change.reason = reason;
}

function validatesAgainstLive(change: Change): boolean {
  // Existence-dep check first: the full payload path must still hold
  // in live state (target root reachable, every no-op/rename ancestor
  // at its claimed position, payload-parent reachable). Reuse the
  // promotion-time walker — it implements §10.2 / §10.3 verbatim.
  const proposal = getProposal(change.proposalId);
  if (proposal !== undefined) {
    const dep = checkExistenceDeps(change, proposal, getState());
    if (!dep.ok) return false;
  }
  if (!structuralPreconditionsHold(change, getState())) return false;
  const caller = change.reviewer ?? "";
  let applied: AppliedMutation;
  try {
    applied = applyMutation(change, caller);
  } catch {
    return false;
  }
  const result = evaluateAll(getState());
  applied.rollback();
  return result.ok;
}

function structuralPreconditionsHold(
  change: Change,
  state: TaxonState,
): boolean {
  // Lightweight structural checks the trial-apply needs to safely run
  // (e.g. detach's required edge, graft's existing source taxon).
  if (change.op === "rename") {
    if (change.taxonId === undefined) return false;
    return state.taxa.has(change.taxonId);
  }
  if (change.op === "detach") {
    const parentId = change.payloadParentTaxonId;
    const childId = change.taxonId;
    if (parentId === undefined || childId === undefined) return false;
    const parent = state.taxa.get(parentId);
    if (parent === undefined) return false;
    return parent.childIds.has(childId);
  }
  // add
  const parentId = change.payloadParentTaxonId;
  if (parentId === undefined) return false;
  if (!state.taxa.has(parentId)) return false;
  if (change.taxonId !== undefined) {
    if (!state.taxa.has(change.taxonId)) return false;
  }
  return true;
}

function isInTree(
  taxonId: TaxonId,
  rootId: TaxonId,
  state: TaxonState,
): boolean {
  if (taxonId === rootId) return true;
  return descendants(rootId, state).includes(taxonId);
}

// --- Mutation primitives ---------------------------------------------------

interface AppliedMutation {
  readonly change: Change;
  readonly caller: string;
  readonly liveTaxonId: TaxonId | undefined;
  readonly rollback: () => void;
}

function applyMutation(change: Change, caller: string): AppliedMutation {
  switch (change.op) {
    case "rename": {
      const taxonId = change.taxonId as TaxonId;
      const t = getTaxon(taxonId);
      if (t === undefined) {
        throw new Error(
          `rename: taxon ${taxonId} disappeared between submission and accept`,
        );
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
        const created = createTaxonFixture(change.name as string, caller);
        attachChildFixture(parentId, created.id);
        return {
          change,
          caller,
          liveTaxonId: created.id,
          rollback: () => {
            detachChildFixture(parentId, created.id);
            removeTaxonFixture(created.id);
          },
        };
      } else {
        const childId = change.taxonId;
        const parent = getTaxon(parentId);
        const alreadyEdge =
          parent !== undefined && parent.childIds.has(childId);
        attachChildFixture(parentId, childId);
        return {
          change,
          caller,
          liveTaxonId: childId,
          rollback: () => {
            if (!alreadyEdge) detachChildFixture(parentId, childId);
          },
        };
      }
    }
    case "detach": {
      const parentId = change.payloadParentTaxonId as TaxonId;
      const childId = change.taxonId as TaxonId;
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

function promoteDirectDependents(
  proposal: Proposal,
  acceptedAdd: Change,
  acceptingReviewer: string,
  audit: CascadeAudit | undefined,
): Change[] {
  const promoted: Change[] = [];
  for (const c of proposal.changes.values()) {
    if (c.nearestAddAncestorChangeId !== acceptedAdd.id) continue;
    if (c.state !== "latent") continue;

    if (audit !== undefined) snapshotIfNew(audit, c);

    if (
      (c.op === "add" || c.op === "detach") &&
      c.payloadParentTaxonId === undefined &&
      acceptedAdd.liveTaxonId !== undefined
    ) {
      const acceptedAddInternal =
        acceptedAdd.payloadPath[acceptedAdd.payloadPath.length - 1];
      if (
        c.payloadPath.length >= 2 &&
        c.payloadPath[c.payloadPath.length - 2] === acceptedAddInternal
      ) {
        c.payloadParentTaxonId = acceptedAdd.liveTaxonId;
      }
    }

    const dep = checkExistenceDeps(c, proposal, getState());
    if (!dep.ok) {
      c.state = "invalid";
      c.reason = `existence dependency ${dep.missing} is no longer in target tree`;
      if (c.op === "add") {
        invalidatePayloadDescendants(
          proposal,
          c,
          `ancestor ${c.id} became invalid`,
          audit,
        );
      }
      continue;
    }

    const reviewer = resolveReviewerAtPromotion(c, acceptingReviewer);
    if (reviewer === null) {
      c.state = "invalid";
      c.reason = `could not resolve reviewer at promotion`;
      continue;
    }
    c.reviewer = reviewer;
    c.state = "queued";
    enqueueChange(c.id, reviewer);
    promoted.push(c);
  }
  return promoted;
}

function resolveReviewerAtPromotion(
  change: Change,
  acceptingReviewer: string,
): string | null {
  if (change.op === "rename") {
    // Re-resolve from live state (§6.2 reassignment may have moved
    // ownership since submission).
    const t = change.taxonId !== undefined ? getTaxon(change.taxonId) : undefined;
    return t?.owner ?? change.reviewer;
  }
  const parentId = change.payloadParentTaxonId;
  if (parentId === undefined) return acceptingReviewer;
  const t = getTaxon(parentId);
  return t === undefined ? null : t.owner;
}

// --- Existence-dep check at promotion --------------------------------------

interface ExistenceDepFailure { ok: false; missing: TaxonId; }
interface ExistenceDepOk { ok: true; }
type ExistenceDepResult = ExistenceDepOk | ExistenceDepFailure;

function checkExistenceDeps(
  change: Change,
  proposal: Proposal,
  state: TaxonState,
): ExistenceDepResult {
  const liveAncestorIds: TaxonId[] = [];
  for (let i = 0; i < change.payloadPath.length - 1; i++) {
    const node = proposal.nodesByInternalId.get(change.payloadPath[i]);
    if (node === undefined) {
      throw new Error(
        `payload node ${change.payloadPath[i]} missing from proposal ${proposal.id}`,
      );
    }
    let liveId: TaxonId | undefined;
    if (node.id !== null) {
      liveId = node.id;
    } else {
      const ancestorChange = node.changeId !== undefined
        ? proposal.changes.get(node.changeId)
        : undefined;
      liveId = ancestorChange?.liveTaxonId;
    }
    if (liveId === undefined) {
      return { ok: false, missing: change.payloadPath[i] as TaxonId };
    }
    liveAncestorIds.push(liveId);
  }

  if (liveAncestorIds.length === 0) return { ok: true };

  const top = liveAncestorIds[0];
  if (!isInTree(top, proposal.targetRootId, state)) {
    return { ok: false, missing: top };
  }

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

// --- §11.4 case 1 propagation ---------------------------------------------

function invalidatePayloadDescendants(
  proposal: Proposal,
  rejected: Change,
  reason: string,
  audit: CascadeAudit | undefined,
): void {
  const rejectedInternal =
    rejected.payloadPath[rejected.payloadPath.length - 1];

  for (const c of proposal.changes.values()) {
    if (c.id === rejected.id) continue;
    if (
      c.state === "accepted" ||
      c.state === "rejected" ||
      c.state === "invalid"
    ) continue;
    const isDescendant = c.payloadPath.slice(0, -1).includes(rejectedInternal);
    if (!isDescendant) continue;

    if (audit !== undefined) snapshotIfNew(audit, c);

    if (c.state === "queued" && c.reviewer !== null) {
      dequeueChange(c.id, c.reviewer);
    }
    c.state = "invalid";
    c.reason = reason;
  }
}

// --- Failure shapes --------------------------------------------------------

function forbidden(message: string): ReviewResult<never> {
  return { ok: false, failure: { kind: "forbidden", message } };
}

function notQueued(
  changeId: ChangeId,
  state: Change["state"],
): ReviewResult<never> {
  return {
    ok: false,
    failure: {
      kind: "conflict",
      message: `change ${changeId} is not in queued state (currently ${state})`,
      details: { kind: "change_not_queued", changeId, state },
    },
  };
}

function conflictFromViolations(
  violations: Violation[],
  changeId: ChangeId,
): ReviewFailure {
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

function cascadeRollbackFailure(
  rootChangeId: ChangeId,
  failedChangeId: ChangeId,
  violations: Violation[],
): ReviewFailure {
  const cause = conflictFromViolations(violations, failedChangeId);
  const causeDetails = cause.kind === "conflict" ? cause.details ?? {} : {};
  return {
    kind: "conflict",
    message: `accept-cascade rooted at ${rootChangeId} rolled back: ${cause.message}`,
    details: {
      kind: "cascade_rollback",
      rootChangeId,
      failedChangeId,
      cause: causeDetails,
    },
  };
}
