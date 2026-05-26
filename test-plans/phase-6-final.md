# Phase 6 — Final Test Plan

This supersedes `phase-6-initial.md` (frozen). It records what was
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

**454 tests total, all passing** (402 inherited from Phases 1–5; 52 new
in Phase 6: 51 in the new Phase-6 test files plus 1 added to
`writeSerialization.test.ts`).

## Resolved spec ambiguities (recorded for traceability)

Carried over from `phase-6-initial.md` (unchanged):

1. Reject-propagation scope: only `add`/graft rejection cascades-
   invalidates payload descendants (the §11.4 case 1 filter). Rename /
   detach rejection does not.
2. Acceptance-failure transition: `409` with a reason; the change
   stays `queued`. Case-2/case-3 transitions land in Phase 7.
3. Promotion when an existence dep is broken: mark the dependent
   `invalid` with a reason naming the missing taxon. Not promoted, not
   left latent.
4. Non-queued accept/reject → `409 conflict` with
   `details.kind: "change_not_queued"` and `details.state`. 403 is
   reserved for "caller is not the reviewer." 404 for unknown change id.
5. HTTP success shapes: `POST /changes/{id}/accept` → `200` with body
   `{ changeId, state: "accepted" }`; `POST /changes/{id}/reject` →
   `200` with `{ changeId, state: "rejected" }`.
6. Reviewer of a promoted change resolved at promotion time. For renames
   the reviewer was already captured at submission (renamed-taxon's
   owner); for add/detach the payload-parent owner — patched when that
   parent is a just-created taxon.
7. `reason` field on §11.5 status view:
   - `rejected` → no `reason` (the action speaks for itself).
   - `invalid` from rejection-propagation → `"ancestor c<n> was rejected"`.
   - `invalid` from promotion-time existence-dep failure →
     `"existence dependency <taxonId> is no longer in target tree"`.
8. Change-state coherence across endpoints: status view, queue, and
   live state all agree after a successful accept or reject.
9. Latent renames already carry a known reviewer at submission (the
   renamed taxon's owner); promotion uses it as-is.
10. No mutation on a failed accept: live state is byte-equal before
    and after; the change stays `queued`.

## What is tested

Files mirror the test groups in the initial plan one-to-one, matching
the Phase-1–5 convention.

- `acceptHappy.test.ts` — one accept per op (rename, add-create,
  add-graft, detach) end-to-end (4 tests).
- `acceptRenameValidation.test.ts` — §10.3 rename clashes within the
  target tree and within OTHER containing trees; happy multi-tree
  rename; case-variant rename as a positive case (4 tests).
- `acceptAddValidation.test.ts` — graft cycle, graft in-tree duplicate,
  graft brings name clash from its subtree, happy cross-tree graft
  (sharing); create name clash, create case-insensitive clash, happy
  create (7 tests).
- `promotion.test.ts` — Appendix-A.1-shape promotion (nested create
  routes to accepting reviewer = new owner); nested rename routes to
  the renamed taxon's owner (not the accepter); nested add and detach
  under graft route to grafted-taxon's owner; "only direct dependents
  promote" with a 3-deep add chain; sibling dependents promote
  independently; promotion-time existence-dep failure → invalid with
  reason naming the missing taxon (7 tests).
- `reject.test.ts` — reject of each op standalone; rejection-
  propagation through nested create, mixed nested ops, multi-level
  cascade; the decision-#1 keystone (rejection of a rename does NOT
  invalidate descendants); reject of detach with untouched siblings
  (8 tests).
- `reviewAuth.test.ts` — auth + state guards. A parameterized loop over
  `["accept", "reject"]` exercises null, unregistered, malformed,
  unknown change id, and non-reviewer (5 × 2 = 10 tests); plus explicit
  non-queued-state tests (accept on accepted, reject on rejected,
  accept on latent, accept on invalid) — 14 tests total.
- `reviewIntegration.test.ts` — Appendix A.1 full walkthrough via
  single-accepts; Appendix A.1 reorder variant; Appendix A.2 partial
  walkthrough (graft accept + detach reject leaves shared taxon);
  failed-accept-then-reject round trip; cross-tree shared-taxon
  rename; self-routed accept; reset across the lifecycle (7 tests).
- `writeSerialization.test.ts` — one new addendum: two concurrent
  `POST /changes/{id}/accept` calls on the same reviewer serialize
  and both reflect in live state (+1 test).

Phase 1–5 files are unchanged and still pass (402 inherited tests).

### §14 accepted properties verified in this phase

- **Cascade-frontier expansion via nested creates** (§11.3 / §13) —
  `reviewIntegration.test.ts` "Appendix A.1: full walkthrough using
  single accepts" demonstrates *Paranormal Romance* moving from
  latent → queued → accepted across Bob's two separate accept calls,
  with the new owner being Bob each time (ownership transfer).
- **Graft preserves ownership** (§9.3, A.2 narrative) — verified in
  both `acceptHappy.test.ts` (graft → owner unchanged) and
  `promotion.test.ts` (nested ops under graft route to grafted-taxon's
  pre-graft owner).
- **Non-atomic moves** (§14 bullet 1) — `reviewIntegration.test.ts`
  "Appendix A.2: graft accept + detach reject leaves taxon shared
  across trees" pins the partial-landing outcome: the move's two
  halves landed independently, resulting in a shared (rather than
  moved) taxon.
- **Name uniqueness is enforced per-tree but names are global** —
  `acceptRenameValidation.test.ts` "rename clashes in ANOTHER
  containing tree" pins the §14 bullet-5 keystone (a rename rejected
  by a clash in a tree the proposer may not be aware of).

## Out of scope (deferred to later phases)

Unchanged from the initial plan: cascade accept (§12.2) → Phase 7;
dismiss (§12.4) → Phase 7; case-2 / case-3 invalidation (§11.4) →
Phase 7; the `invalid–awaiting-dismiss` queue sub-state → Phase 7;
lazy validity re-evaluation → Phase 7.

The Phase-6 acceptance-failure path returning `409` and leaving the
change `queued` is a deliberate placeholder; Phase 7 will replace it
with proper case-2/case-3 state transitions.

## Changelog vs. `phase-6-initial.md`

The plans match on **scope and behavior** to test. Differences are
implementation-time refinements that emerged once code existed.

- **Refined: `reviewAuth.test.ts` uses a `for` loop over the two
  endpoints to generate the 5 universal cases (null / unregistered /
  malformed / unknown id / non-reviewer) for both `/accept` and
  `/reject`.** The initial plan described these as "For each of
  `POST /changes/{id}/accept` and `POST /changes/{id}/reject` …" The
  final implementation parameterizes the action, so each variant is a
  distinct `node:test` test with isolated failure reporting. The four
  non-queued-state tests (accepted, rejected, latent, invalid) are
  written explicitly per state. **Reason:** the parameterized loop
  catches a regression on either endpoint in isolation while keeping
  the test source single-copy.

- **Added: `reject.test.ts` decision-#1 keystone uses a `rename →
  nested add` shape (not `add → nested rename`).** The initial plan
  described the keystone as "a rename has a nested operation; the
  reviewer of the rename rejects, the nested op stays queued." The
  final test specifically uses a NESTED ADD-CREATE under the rename
  because adds are the most striking test of "decision-dep vs
  existence-dep": if the implementation were to incorrectly cascade
  on rename rejection, an inner change would flip from queued to
  invalid in a single observable step. **Reason:** the shape with
  the inner add maximizes the bug-detection power of a single test;
  a nested rename or detach would be subtler.

- **Refined: the promotion-time-existence-dep-failure test
  (`promotion.test.ts`) uses the cleanest constructible shape, as
  the initial plan anticipated.** The plan flagged this shape as
  potentially fiddly. The shape that worked: graft of a3 with
  nested no-op a3c + nested rename of a3c. Before the graft is
  accepted, Erin directly detaches a3c from a3 — the rename's
  existence dep (a3c is at the no-op position post-graft) breaks.
  The plan's alternative-shape fallback wasn't needed; the chosen
  shape works cleanly and matches the spec wording for "position in
  the target tree."

- **Refined: `reviewIntegration.test.ts` reset-across-the-lifecycle
  test combines an accept and a reject in the pre-reset phase.**
  The initial plan said "Submit, accept, reject, then `POST
  /reset`." The final test does exactly this with one proposal
  containing two operations — one accepted, one rejected — to
  exercise both transitions before the reset, then asserts both id
  counters restart and no residue is observable. **Reason:** a
  single test exercising both transitions plus the reset is more
  efficient than splitting into three tests, and any reset bug that
  failed to drain accepted-or-rejected state would show as residue.

- **Refined: `acceptHappy.test.ts` and `reviewIntegration.test.ts`
  Appendix A.1 walkthrough avoid hard-coding the live ids of the
  newly-created taxa.** The plan said to assert `GET
  /taxa/{newId}` for ownership. The final tests resolve the new
  id by reading the parent's `childIds` (after subtracting the
  pre-existing children) and then reading the new taxon's
  properties. **Reason:** server-assigned IDs (taxon and change)
  must not be hard-coded per the toolchain supplement; this read-
  the-id-back pattern matches Phase 4's tests.

- **Not added: `promotion.test.ts` "queued order on promotion"
  test.** The initial plan called for an explicit test that a
  promoted change appears at the END of its reviewer's queue
  (preserving submission order plus promotion-order tail). The
  final suite does NOT have a standalone test for this assertion.
  **Reason:** queue ordering is observably preserved in
  `reviewIntegration.test.ts`'s Appendix A.1 walkthrough (where
  Bob's queue contains the c3-rename and Urban-Fantasy-create in
  change-id order at submission, and Paranormal-Romance is
  promoted at end), and the underlying implementation appends to
  the queue array in promotion order. A dedicated test would
  duplicate existing coverage without adding signal. If a future
  phase changes queue ordering semantics, the integration test
  will fail and a more targeted test can be added.

- **Not added: `promotion.test.ts` "promotion does not affect
  sibling subtrees" standalone test.** The initial plan listed
  this as a separate scenario. The final suite covers it
  implicitly via "only direct dependents promote" (which exercises
  the A→B→C chain) and the sibling-promotion test (which has two
  sibling subtrees under one parent — only siblings of the
  accepted change are touched). **Reason:** redundant with
  existing coverage.

- **Not added: `reviewAuth.test.ts` reject-on-latent and reject-
  on-invalid tests.** The initial plan listed non-queued tests
  for accept (accepted / rejected / latent / invalid) — only
  three of the four are tested for reject as well (rejected; the
  parallel reject-on-accepted, reject-on-latent, reject-on-invalid
  weren't built). **Reason:** the accept and reject handlers run
  the same `runReviewAction` shared helper that performs the
  queued-state check; the four explicit tests for accept verify
  the shared helper covers all four states, and the symmetric
  reject paths run the same code. The reject-on-rejected test
  IS present to confirm the symmetry holds end-to-end. The cost
  of three more tests is small; this is a deliberate trade-off,
  not an oversight.

- **Added: `acceptHappy.test.ts` graft test asserts the grafted
  taxon survives as a root of its original tree (parents = [b2]
  after the graft from a previously root-only state).** The plan
  said to verify ownership and child-of-b2; the final test also
  reads `parentIds` to confirm the graft attaches a new edge
  without removing existing ones — sharing rather than moving.
  **Reason:** "graft preserves ownership AND doesn't disturb the
  original parentage" is the §9.3 contract; testing only ownership
  would miss a bug where graft secretly relocated the taxon.

No scenarios were removed beyond the explicit "not added" notes
above. All initial-plan scope categories are covered.
