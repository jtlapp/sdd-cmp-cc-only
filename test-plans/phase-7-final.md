# Phase 7 — Final Test Plan

This supersedes `phase-7-initial.md` (frozen). It records what was
actually tested, with a changelog of how it differs from the frozen
initial plan and the reason for each change.

## Run command

```
npm test                 # tsc && node --test "dist/**/*.test.js"
```

Or, equivalently:

```
npx tsc
node --test "dist/**/*.test.js"
```

**500 tests total, all passing** (454 inherited from Phases 1–6; 46
new in Phase 7: 45 across the seven new Phase-7 test files plus 1
added to `writeSerialization.test.ts`).

## Resolved spec ambiguities (recorded for traceability)

Carried over from `phase-7-initial.md` (unchanged except as noted
below):

1. Case-2 vs case-3 labeling — by immediately-causing actor.
2. Lazy evaluation scope — case-2 at end-of-write; case-3 on read /
   action entry; never globally eager.
3. Cascade rollback granularity (errata E1) — full atomic.
4. Cascade frontier extends through ownership transfer; iterative
   apply-promote-check.
5. Dismiss on a not-queued invalid → `409 conflict` with
   `details.kind: "change_not_in_queue"`.
6. Cascade boundary at non-queued state.
7. Failed single-accept → case-2 auto-dismiss (replaces Phase-6
   placeholder).
8. Rollback restoration is byte-equal in both live state and
   bookkeeping.
9. HTTP shapes for cascade and dismiss.
10. Reason strings for each §11.4 transition.
11. Proposer view shows only `invalid`; only `/queue` distinguishes
    case-3 from case-2.

### Implementation-time refinements to plan decisions

12. **Lazy re-eval at review-action entry SKIPS the targeted change.**
    Discovered during implementation when several Phase-6 tests
    regressed: an aggressive lazy pass marked the about-to-be-accepted
    change as case-3 invalid before the action's own validator could
    run, hiding the underlying conflict cause (e.g. `name_clash`)
    behind a generic `change_not_queued`. The fix: `lazyReevaluateExternal`
    takes an optional `skipChangeId`, and the route layer passes the
    action's targeted change id so its validity is decided by the
    action itself (case-2 if it fails). Non-targeted queued changes
    still get lazily re-evaluated. (See changelog entry C-LAZY.)

13. **`existenceDepsHold` for lazy re-eval reuses `checkExistenceDeps`
    rather than its own shallow shape check.** Initial implementation
    had a hand-written check that only verified `payloadParentTaxonId`
    is reachable from `targetRootId`; this missed the case where a
    rename's path through a no-op ancestor is broken. Final
    implementation calls the promotion-time `checkExistenceDeps`
    walker over the change's full payload path, matching §10.2 /
    §10.3 exactly. (Discovered while writing the §14 bullet-4 cascade-
    delete integration test.)

14. **Dismiss authorization check order.** Initial design had a
    blanket "caller must equal change.reviewer" guard. But case-1
    invalids never get a reviewer assigned (their nearest add-ancestor
    was rejected before promotion could resolve them), so dismiss on
    case-1 returned 403 instead of the planned 409 `change_not_in_queue`.
    Final check order: 403 only if `change.reviewer !== null && !==
    caller`; then state check (`change_not_invalid`); then queue
    membership (`change_not_in_queue`).

## What is tested

Files mirror the test groups in the initial plan one-to-one, matching
the Phase-1–6 convention.

- `cascadeHappy.test.ts` — degenerate one-step cascade; Appendix-A.1
  ownership-transfer expansion; cascade bounded by other-owner
  routing (Erin boundary under a grafted taxon); cascade bounded by
  leaves; mixed nested ops in topological order; self-routed cascade
  (6 tests).

- `cascadeRollback.test.ts` — mid-cascade in-tree name clash; mid-
  cascade cross-tree name clash (§14 bullet-5); mid-cascade cycle
  (graft of ancestor); mid-cascade in-tree duplicate (diamond);
  first-step failure rolls back cleanly; §12.2 standalone-vs-cascade
  non-equivalence (6 tests).

- `invalidation.test.ts` — case-1 propagation widened to add/graft
  becoming invalid (not just rejected); case-1 cascades through
  nested add chain A1→A2→A3; case-2 from successful accept; case-2
  from failed accept (replaces Phase-6 placeholder); case-2 via
  cascade; case-3 from direct rename by another user; case-3 from
  direct detach (Appendix A.2 tail); case-3 from a different
  reviewer's accept on a different proposal (8 tests).

- `invalidationLazy.test.ts` — unrelated writes don't eagerly
  transition; lazy detection on `GET /queue`; lazy detection on
  review-action entry for non-targeted queued changes; idempotence
  of successive reads (4 tests).

- `dismiss.test.ts` — happy path; dismiss on still-queued/valid;
  case-1 (never queued); case-2 (already dismissed); accepted change;
  rejected change; null/unregistered/malformed/unknown id/non-
  reviewer auth + state guards; idempotence-in-effect-not-state on
  double-dismiss (12 tests).

- `phase7Integration.test.ts` — Appendix A.1 via cascade; Appendix
  A.2 in full (graft + reject-detach + external invalidate + dismiss);
  §14 bullet 2 collaborative deletion; §14 bullet 3 ownership
  reassignment reroutes promotion-time reviewer; §14 bullet 4
  cascade-delete halts and invalidates; reset across the Phase-7
  lifecycle (6 tests).

- `phase7StatusView.test.ts` — proposer view shows `invalid`
  uniformly across all three cases; `/queue` includes case-3 only;
  cascade-accepted set is clean from the queue post-cascade (3
  tests).

- `writeSerialization.test.ts` — addendum: two concurrent
  `accept-cascade` calls serialize under §11.1 (+1 test).

Phase 1–6 files are unchanged in test count (454 inherited tests),
with two Phase-6 tests *rewritten* to assert the new Phase-7 case-2
behavior in place of the Phase-6 "stays queued" placeholder:

- `acceptRenameValidation.test.ts` "rename to a name that clashes in
  the target tree" — now asserts `disposition: invalid` after the
  failed accept (was: `queued`).
- `reviewIntegration.test.ts` "failed accept does not mutate live
  state; subsequent reject succeeds" — renamed to "...change
  transitions to invalid (§11.4 case 2)"; the body now asserts the
  case-2 auto-dismissal and that a subsequent reject returns 409
  `change_not_queued` with `state: "invalid"`.

### §14 accepted properties verified in this phase

- **Moves are non-atomic** (§14 bullet 1) — `phase7Integration` /
  Appendix A.2 in full, ending in case-3 invalidation and dismissal.
- **Deletion may require collaboration** (§14 bullet 2) — explicit
  multi-step scenario in `phase7Integration`.
- **Ownership reassignment is unilateral** (§14 bullet 3) — explicit
  scenario showing promotion-time reviewer resolution picking up the
  new owner.
- **Cascade deletion never removes other users' taxa** (§14 bullet 4)
  — exercised in conjunction with proposal-layer invalidation in
  `phase7Integration`.
- **Name uniqueness is enforced per-tree but names are global**
  (§14 bullet 5) — pinned in `cascadeRollback`'s cross-tree clash
  test.

## Out of scope

Phase 7 is the final phase. Nothing is deferred to a later phase.

### Known gaps (intentional)

- The §12.2 wording correction has been recorded as
  `prd/prd-errata.md` E1 (per user direction not to edit `prd/prd.md`
  directly). The implementation follows §12.2's atomic-rollback
  semantics; §15.5's stale partial-commit wording is overridden by
  the errata file but remains physically present in the PRD.

## Changelog vs. `phase-7-initial.md`

The final plan matches the initial plan on scope and behavior. The
following are implementation-time refinements that emerged once code
existed.

- **C-LAZY: lazy re-eval at action entry skips the targeted change.**
  The initial plan said lazy re-eval runs on action entry against
  "any change in that queue." The final implementation skips the
  targeted change. **Reason:** running lazy re-eval on the targeted
  change marked it case-3 invalid before the action's own validator
  could fire, downgrading the conflict response from a meaningful
  `name_clash`/`cycle`/`in_tree_duplicate` to a generic
  `change_not_queued`. Plan decision 7 (failed-accept → case-2 auto-
  dismiss) demands the action itself decides the change's fate.
  Recorded in the resolved-ambiguities index as decision 12.

- **C-EXIST: `existenceDepsHold` reuses `checkExistenceDeps` rather
  than its own shape check.** Discovered while writing the §14
  bullet-4 integration test: the initial hand-written check only
  verified `payloadParentTaxonId` reachability; it missed cases
  where the payload path threaded through a no-op ancestor whose
  position has changed. Recorded as decision 13.

- **C-DISMISSAUTH: dismiss authorization re-ordered to handle
  reviewer=null on case-1 invalids.** Initial design did a blanket
  caller=reviewer check first, which returned 403 instead of 409
  `change_not_in_queue` for case-1 invalids whose reviewer was
  never resolved. Final order: (a) 403 only if reviewer is set AND
  not the caller; (b) `change_not_invalid` if not invalid; (c)
  `change_not_in_queue` if invalid but not in this caller's queue.
  Recorded as decision 14.

- **Added: §11.4 case-2 reason string for failed-accept includes
  the `self-invalidated by` prefix.** The initial plan said the
  reason should be `"self-invalidated by your accept of <changeId>"`,
  but my first implementation set it to just `"your accept of
  <changeId>"`. Fixed during the case-2 test for failed accept.

- **Added: `writeSerialization.test.ts` addendum for cascade
  concurrency.** Initial plan listed this in group 6 alongside the
  other integration tests; the final test landed in
  `writeSerialization.test.ts` instead, matching the Phase-6
  convention of grouping all §11.1 lock tests together.

- **Refined: `cascadeRollback.test.ts` snapshot helper uses the
  actual `/trees` response shape `{ trees: [...] }`, not the
  guessed-wrong `{ roots: [...] }`.** Initial plan didn't specify
  the exact response shape; the implementation reads the existing
  endpoint contract from `src/routes/reads.ts`.

- **Refined: `phase7Integration.test.ts` "§14 ownership
  reassignment" uses a nested *rename* (not a nested add-create
  whose payload-parent is a no-op-anchored existing taxon).**
  Initial plan described the scenario in terms of a no-op anchor;
  but that shape asserts the anchored taxon is a child of an add-
  create's new position, which it isn't (existence-dep fails at
  promotion time, marking the dependent invalid for the wrong
  reason). The rename shape pins exactly the §6.2 →
  promotion-time-reviewer interaction without confounding it with
  existence-dep failure. **Reason:** the simpler shape isolates the
  property being tested.

- **Not added: a separate "queue order on cascade rollback" test.**
  The cascade rollback tests assert `deepEqual` on the full status
  view (`snapshotProposal`), which transitively pins queue ordering
  because the status view derives from the same backing state.
  A dedicated queue-order assertion would duplicate this coverage.

- **Not added: an explicit "case-2 from rejection of an add/graft
  with siblings" test.** §11.4 case 2 says self-invalidation happens
  when *the reviewer's own action causes another of their queued
  changes to no longer validate*. Reject doesn't mutate live state,
  so it can only break a sibling via case-1 propagation, which is
  separately tested. The `rejectChange` code path still runs the
  case-2 re-validation pass for symmetry, but it's a no-op in
  practice. **Reason:** the symmetry-only behavior doesn't warrant
  a dedicated test.

No scenarios were removed beyond the explicit "not added" notes
above. All initial-plan scope categories are covered.
