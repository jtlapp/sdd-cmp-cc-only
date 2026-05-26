# Phase 7 — Initial Test Plan (FROZEN)

This plan is written from the spec (`prd/prd.md` §11.4, §12.2, §12.4,
§13, §14, §15.5, Appendix A, plus `prd/prd-errata.md` E1) and
`prd/phase-7-cascade-invalidation-integration.md` **before
implementation begins**. Once any Phase-7 implementation code lands,
this file is frozen and must not be edited. The phase's
`phase-7-final.md` supersedes it and records what was actually tested,
with a changelog.

## Scope under test

Phase 7 layers three behaviors onto the Phase-6 single-review baseline,
then exercises the whole system end to end:

- **Atomic accept-cascade (§12.2, §15.5 corrected by errata E1).**
  `POST /changes/{id}/accept-cascade` accepts the maximal recursive set
  of changes the reviewer can accept within the rooted payload subtree,
  bounded by other-owner changes and by leaves, applied in
  payload-topological order. **Atomic**: any constituent validation
  failure rolls back the entire cascade to pre-call state and returns a
  reason. The §12.2 note that cascade-internal validation is sequential
  against evolving state (and therefore non-equivalent to standalone
  validation) is intended behavior and is exercised.

- **Three-mode invalidation (§11.4), lazily evaluated.**
  - **Case 1 (dependency failure).** Extended from Phase-6's
    reject-propagation to also fire when an `add`/graft *becomes
    invalid* (case-2 or case-3 on an add/graft propagates the same way
    rejection did). Payload descendants of an invalidated add/graft
    become `invalid`.
  - **Case 2 (self-invalidation).** A reviewer's own action (accept,
    accept-cascade, or reject) that causes another of *that same
    reviewer's* queued changes to no longer validate auto-dismisses
    that change (`invalid`, dequeued, no further action).
  - **Case 3 (external invalidation).** Any *other* action (a direct
    §6.2/§6.3/§6.4 mutation by anyone, or an accept/cascade by a
    *different* reviewer on a *different* proposal) that causes a
    queued change to no longer validate marks it `invalid` but **keeps
    it in the reviewer's queue** until that reviewer calls dismiss.
  - **Labeling rule (planning decision 1).** Case-2 vs case-3 is
    decided by the immediately-causing actor: same reviewer → case 2,
    anyone else → case 3.
  - **Lazy evaluation (§11.4 last paragraph, planning decision 2).**
    We never eagerly scan all queues after an unrelated mutation. We
    re-validate the *reviewer's own* queue at the end of each of their
    accept/cascade/reject calls (to detect case 2 immediately, as
    "auto-dismissed with no action required" demands). For case 3 we
    re-validate the queue on `GET /queue` reads and on review-action
    entry against any change in that queue — i.e. only when the
    reviewer actually looks. Validity is determined by a trial
    apply-and-evaluate against current live state, then rollback (the
    same evaluator the §6 writes and §12.1 accept paths use), so the
    judgment is identical across paths.

- **Dismiss (§12.4, §15.5).** `POST /changes/{id}/dismiss`. Reviewer
  only; only succeeds when the change is currently in the reviewer's
  queue AND in state `invalid` (case 3). On success, dequeues; state
  stays `invalid` (terminal). Case-1 and case-2 invalids are not
  dismissable because they aren't queued — dismiss on those returns
  `409 conflict` with `details.kind: "change_not_in_queue"` (planning
  decision 5).

- **Integration / §13 matrix.** End-to-end suites exercising the full
  lifecycle across all phases, including §14 accepted properties.

## Resolved spec ambiguities (decided up front, recorded for traceability)

These were discussed and confirmed during planning.

1. **Case-2 vs case-3 labeling.** Decided by the immediately-causing
   actor: if the action that just ran is the affected change's reviewer
   acting on one of their own queued changes (accept / accept-cascade /
   reject), an unrelated queued change of theirs that breaks is
   case-2 (auto-dismiss). Any other action — a direct §6.2/§6.3/§6.4
   mutation, OR an accept/cascade by a *different* reviewer (even on
   a related taxon) — is case-3 (mark invalid, keep queued, await
   dismiss).

2. **Lazy evaluation scope.** Case-2 detection runs at the end of the
   triggering reviewer's own write (synchronous within the same
   request, since the spec says "automatically dismissed … with no
   action required"). Case-3 detection runs on the affected reviewer's
   next `GET /queue` read or next review-action attempt against any
   queued change — i.e. fully lazy, never eagerly. We do **not** run a
   global re-validation pass after every write.

3. **Cascade rollback granularity (errata E1).** §12.2 governs: cascade
   is atomic; any constituent failure rolls back the whole cascade.
   Errata E1 records the §15.5 wording correction. No partial commit.

4. **Cascade frontier extends through ownership transfer.** When the
   cascade accepts an `add`-create, the new taxon's owner becomes the
   cascading reviewer; nested ops whose payload-parent is the new
   taxon therefore route to the same reviewer and join the cascade.
   The cascade is **iterative** (apply → promote → look at what's
   newly queued to this reviewer → continue), not precomputed.

5. **Dismiss on a not-queued invalid change.** Returns `409 conflict`
   with `details.kind: "change_not_in_queue"`. 404 would be wrong (the
   change does exist); 403 is reserved for "caller is not the reviewer."

6. **Cascade boundary at non-queued state.** A cascade's expansion
   stops at: (a) other-owner changes (per §12.2), (b) leaves, (c)
   changes already `accepted` / `rejected` / `invalid` (cannot
   re-accept). When promotion would mark a dependent `invalid` (e.g.
   existence-dep broken at promotion time), the cascade simply does
   not extend into that branch; this is not a cascade failure.

7. **Acceptance-failure transition (replaces Phase-6 placeholder).**
   A failed single-accept (`POST /changes/{id}/accept`) no longer
   leaves the change `queued` with a 409 (the Phase-6 placeholder).
   Instead, the change transitions per §11.4 case-2: it is auto-
   dismissed (invalid, dequeued) because the failure was triggered by
   the reviewer's own attempt. The HTTP response is still `409` with
   a reason; the reviewer learns of the auto-dismissal via the
   response and via their next `/queue` read. (This is the Phase-7
   delivery of the case-2 path the Phase-6 plan explicitly deferred.)

8. **Cascade rollback restoration.** On rollback, every change that
   was mutated during the cascade is restored byte-equal:
   `state`, `reviewer`, `liveTaxonId`, queue membership and queue
   position, and any descendants marked `invalid` via propagation
   inside the cascade. Live state (taxa, edges, owners) is restored
   via the same `rollback` closures the Phase-6 single-accept path
   already uses.

9. **HTTP shapes.**
   - `POST /changes/{id}/accept-cascade` on success → `200 OK` with
     body `{ rootChangeId, acceptedChangeIds: [c1, c2, ...] }`
     (the seed first, then in cascade application order).
   - `POST /changes/{id}/dismiss` on success → `200 OK` with body
     `{ changeId, state: "invalid", dismissed: true }`.
   - On failure both endpoints return the §15.6 envelope with the
     standard HTTP status mapping. Cascade-failure 409 includes
     `details.kind: "cascade_rollback"` plus `details.failedChangeId`
     and the failing invariant violation under `details.cause`.

10. **`reason` on §11.4 invalid transitions.**
    - Case-2 auto-dismiss from a failed single-accept:
      `"self-invalidated by your accept of <changeId>"`.
    - Case-2 auto-dismiss from a successful accept that broke a
      sibling: `"self-invalidated by your accept of <changeId>"`.
    - Case-2 from cascade: `"self-invalidated by your accept-cascade
      rooted at <rootChangeId>"`.
    - Case-3 external (queued, awaiting dismiss):
      `"externally invalidated"` (kept short; the proposer's view
      doesn't surface the actor).
    - Case-1 propagation from a now-invalid ancestor:
      `"ancestor <changeId> became invalid"` (mirrors the Phase-6
      rejection-propagation wording).

11. **Status view (§11.5) coherence.** Per §11.5, the proposer view
    shows only `invalid` for all three cases; the `reason` field per
    decision 10 is informational. The proposer view does **not**
    distinguish case-2 (auto-dismissed) from case-3 (awaiting
    dismiss); only the reviewer's `/queue` does (case-3 entries
    appear; case-2 entries do not).

## Coverage dimensions (per the brief)

The brief enumerates three coverage dimensions for this phase. Each
maps to the test groups below.

- **New behavior** — accept-cascade including ownership-transfer
  frontier expansion (group 1), each constituent failure mode and
  full rollback (group 2), each of the three §11.4 invalidation modes
  (group 3), lazy evaluation (group 4), dismiss (group 5).
- **Interactions with earlier phases** — direct actions by one user
  invalidating another user's queued change (group 3 case-3); cascade
  validation reuses §3.3 invariants (group 2); the Appendix A.1 and
  A.2 walkthroughs run end-to-end in group 6; ownership reassignment
  by §6.2 affecting future routing in group 6; deletion cascades
  detaching other-owned taxa interacting with proposals in group 6.
- **Failure and invalid states** — group 2 (mid-cascade failure /
  full rollback), group 3 (each invalidation route, including the
  proposer-view and reviewer-queue projections), group 5 (dismiss
  preconditions).

### §14 accepted properties verified in this phase

- **Moves are non-atomic** (§14 bullet 1) — Appendix A.2 in full,
  including the external-invalidation tail (group 6).
- **Deletion may require collaboration** (§14 bullet 2) — a multi-step
  scenario where U's delete is blocked by a shared U-owned taxon,
  resolved by proposing detaches from the other parents, then
  retrying delete (group 6).
- **Ownership reassignment is unilateral** (§14 bullet 3) — a
  scenario where ownership reassignment mid-lifecycle reroutes a
  pending change's reviewer at promotion time (group 6).
- **Cascade deletion never removes other users' taxa** (§14 bullet 4) —
  exercise the §6.3 halt-and-detach behavior in an integration
  context where the detached taxon was the payload-parent of a
  queued change (case-3 external invalidation) (group 6).
- **Name uniqueness is enforced per-tree but names are global**
  (§14 bullet 5) — cascade rolls back when a constituent rename
  validates inside the target tree but clashes in another containing
  tree (group 2).

## Test groups

File names are nominal; the implementation may split or merge as long
as the listed scenarios are covered. Continues the per-phase
`*.test.ts` convention; `test/proposalsTestHelpers.ts` carries shared
boilerplate. New helpers for `accept-cascade` and `dismiss` calls join
it.

### 1. Accept-cascade happy paths — `cascadeHappy.test.ts`

- **Single-step "cascade" of one change** — cascade rooted at a queued
  rename with no nested ops. The cascade accepts just the seed (no
  promotion targets). Response body lists exactly that one change in
  `acceptedChangeIds`. Sanity-check that cascade reduces to single
  accept in the degenerate case.

- **Cascade extending through ownership transfer (Appendix A.1
  Paranormal Romance shape).** Carol proposes anchored at `r1` (owned
  by Alice) with a nested `add`-create *Urban Fantasy* under `c2`
  (Bob), and a further nested `add`-create *Paranormal Romance* under
  *Urban Fantasy*. Bob calls `accept-cascade` rooted at the *Urban
  Fantasy* create. The cascade accepts *Urban Fantasy* (Bob becomes
  its owner), promotes *Paranormal Romance* (routed to Bob), accepts
  it (Bob becomes its owner), and returns both ids in order. Live
  state reflects both new taxa with Bob as owner; the proposer's
  status view shows both `accepted`.

- **Cascade bounded by other-owner routing.** Cascade rooted at an
  `add`-create whose nested child is an `add`-graft of an Erin-owned
  existing taxon under the new (cascade-owned) parent — wait,
  ownership of the *grafted* taxon doesn't transfer, but ownership of
  the just-created parent does. The graft routes to the new parent's
  owner (the cascading reviewer), so it joins the cascade. Then a
  nested op *under* the grafted taxon routes to the grafted taxon's
  owner (Erin) — that branch is bounded. Verify the cascade accepted
  exactly the in-frontier set and Erin's now-promoted change sits
  queued for her.

- **Cascade bounded by leaves.** A cascade rooted at an `add`-create
  with no nested ops accepts just the one change (frontier ends at
  leaf).

- **Cascade with mixed nested ops** — a `rename` and `detach` nested
  under an `add`-create. Both route to the cascading reviewer
  (rename → owner of renamed taxon; detach → owner of payload-parent
  = the just-created taxon = cascading reviewer). All three accept
  atomically, in payload-topological order (parent create before its
  nested children).

- **Cascade self-routed.** Reviewer proposes against their own tree,
  becomes the reviewer of every change, and cascades — sanity check
  that nothing in the routing code assumes a different proposer.

### 2. Accept-cascade rollback — `cascadeRollback.test.ts`

Each test asserts: (a) response is `409 conflict` with
`details.kind: "cascade_rollback"`, `details.failedChangeId` naming
the offender, and `details.cause` carrying the invariant violation;
(b) **every** change in the cascade has its `state`, `reviewer`,
`liveTaxonId`, and queue position restored byte-equal; (c) live state
(taxa, edges, owners) is byte-equal to its pre-call value (via `GET
/taxa` and `GET /trees/{root}` snapshots).

- **Mid-cascade in-tree name clash.** Cascade contains a rename and a
  nested add-create. The add-create's name happens to clash with a
  sibling created earlier in the cascade. Cascade rolls back; the
  rename is also undone even though it had validated standalone.

- **Mid-cascade cross-tree name clash.** Cascade contains a rename of
  a multi-tree-shared taxon to a name that clashes in *another*
  containing tree (the §14 bullet-5 keystone). Cascade rolls back.

- **Mid-cascade cycle.** A nested add-graft would close a cycle (graft
  of an ancestor under a descendant). Cascade rolls back, including
  the seed's prior changes.

- **Mid-cascade in-tree duplicate (diamond).** Graft within the
  cascade would make a taxon reachable by more than one path in the
  same tree. Cascade rolls back.

- **First-step failure rolls back nothing-applied cleanly.** The seed
  change itself fails validation. The cascade returns the same 409
  shape; nothing was mutated; the seed remains `queued`.

- **§12.2 standalone-vs-cascade non-equivalence.** A cascade rolls
  back because step N would create a clash, even though step N would
  have validated standalone against pre-cascade state (the clash is
  introduced by an earlier accepted step within the same cascade).
  Pin this with a single test: same change, accepted standalone =
  succeeds; accepted as the inner step of a cascade where an earlier
  step set up the clash = whole cascade rolls back. Demonstrates the
  intended non-equivalence.

### 3. Three-mode invalidation — `invalidation.test.ts`

Covers §11.4 cases 1, 2, and 3.

- **Case 1 from `add`/graft becoming invalid (not just rejected).**
  Add-create A with nested rename R under it. A is *invalidated* (not
  rejected) by case-3 — e.g. A's payload-parent taxon is directly
  deleted by its owner before A is acted on. R (latent under A)
  becomes `invalid` with reason `"ancestor <A> became invalid"`. The
  reviewer of A sees it as `invalid–queued` (case 3 for A itself);
  the proposer view shows both as `invalid`.

- **Case 2 from successful accept.** Reviewer Alice has two queued
  changes: rename `t1 → "Foo"`, and rename `t2 → "Foo"` (both in the
  same tree). Accepting the first succeeds. The second now clashes
  (would produce a duplicate name). It is auto-dismissed (case 2):
  `state: invalid`, dequeued, no further action required. Alice's
  `/queue` no longer contains it. Proposer view shows `invalid` with
  reason naming the triggering accept.

- **Case 2 from failed accept (replaces Phase-6 placeholder).**
  Alice's queued rename targets a name that already exists in another
  containing tree (a §10.3 cross-tree clash she didn't know about).
  Alice calls accept → 409. The change is **auto-dismissed (case 2)**
  with reason `"self-invalidated by your accept of <changeId>"`.
  Alice's `/queue` no longer contains it. (Pin the Phase-7 contract
  change vs. Phase-6's "stays queued" placeholder.)

- **Case 2 from cascade.** Cascade succeeds end-to-end but the
  cascading reviewer had a *separate* queued change (outside this
  cascade) that the cascade's mutations broke. That separate change
  is auto-dismissed; cascade itself is committed. Reason names the
  cascade's root change id.

- **Case 3 from direct edit by another user.** Alice has a queued
  rename of `c1`. Bob (owner of `c1`'s containing tree, separately)
  directly renames a sibling of `c1` to the exact name Alice intends.
  Alice's queued rename now fails the in-tree-uniqueness invariant.
  On Alice's next `/queue` read, the change is shown with `state:
  invalid` and still present in her queue. Reason
  `"externally invalidated"`.

- **Case 3 from direct delete by another user.** Erin has a queued
  add-create whose payload-parent was a graft Frank accepted earlier.
  Frank then directly detaches the grafted taxon from his tree. On
  Erin's next `/queue` read, the change appears `invalid` and queued.
  (This is the Appendix A.2 *Unreliable Narrator Thriller* tail.)

- **Case 3 from another reviewer's accept on a different proposal.**
  Two independent proposals, two different reviewers. Reviewer X
  accepts a change that breaks one of reviewer Y's queued changes.
  Y's change becomes case-3 invalid on Y's next read.

- **Case 1 invalidation cascades through nested add chain.** A1 → A2
  → A3 (nested add-creates). A1 is invalidated (case 3, say its
  payload-parent gets directly deleted). A2 and A3 (both latent under
  A1) become case-1 invalid via propagation.

### 4. Lazy evaluation — `invalidationLazy.test.ts`

Asserts that re-validation only fires at the lazy seams (queue read
and review-action entry), not on unrelated writes.

- **No eager work on unrelated writes.** Alice has a queued change.
  Bob does a long sequence of direct §6.2/§6.4 writes on a
  completely unrelated tree. Alice's queued change's `state` is
  observably unchanged in the in-memory record until Alice calls
  `GET /queue`. (We can't directly measure "no eager work" via HTTP,
  so this test reads the change's state via `GET /proposals/{id}`
  before any of Alice's reads — it remains whatever it was set to —
  then has Alice call `/queue`, at which point lazy evaluation
  decides whether it changed.)

- **Lazy detection on `GET /queue`.** Alice has a queued rename;
  externally, the rename's tree gets a sibling with the target name.
  Alice's `/queue` response reflects the change as `invalid` (and the
  proposal status view does too once the lazy pass runs). The change
  remains in the queue (case 3).

- **Lazy detection on review-action entry.** Same setup, but Alice
  calls `accept` on the now-invalid change without first reading
  `/queue`. The entry-time check labels it case-3 invalid (since the
  invalidating actor was someone else) and the accept fails
  appropriately — 409 with reason naming the underlying violation;
  change is left in the queue as `invalid` awaiting dismiss.

- **Idempotence of lazy passes.** Two successive `GET /queue` calls
  with no intervening mutation produce identical responses (no
  spurious re-labeling, no state churn).

### 5. Dismiss — `dismiss.test.ts`

§12.4 + §15.5 + planning decision 5.

- **Happy path.** Set up a case-3 invalid queued change. Reviewer
  calls dismiss → `200` with `{ changeId, state: "invalid",
  dismissed: true }`. `/queue` no longer contains it. Proposal status
  view still shows it `invalid`.

- **Dismiss when not yet invalid (still queued, still valid).** Pre:
  the change is in `queued` state. Dismiss → `409 conflict` with
  `details.kind: "change_not_invalid"`. Change unchanged.

- **Dismiss on case-1 (never queued).** A latent change that became
  invalid via ancestor rejection. Dismiss → `409 conflict` with
  `details.kind: "change_not_in_queue"`. Change unchanged.

- **Dismiss on case-2 (already auto-dismissed).** Pre: case-2
  auto-dismiss. Dismiss → `409 conflict` with `details.kind:
  "change_not_in_queue"`. Change unchanged.

- **Dismiss on accepted / rejected change.** → `409 conflict` with
  `details.kind: "change_not_invalid"` (state shows what it is).

- **Auth + state guards.** Loop over the same matrix Phase-6's
  `reviewAuth.test.ts` runs for accept/reject: null caller, malformed
  username, unregistered username, unknown change id, non-reviewer
  caller. Each returns the expected §15.6 status.

- **Dismiss is idempotent in effect but not in state.** After a
  successful dismiss, a second dismiss on the same change returns
  `409 conflict` with `details.kind: "change_not_in_queue"`. (Once
  removed from queue, it can't be re-dismissed.)

### 6. End-to-end integration — `phase7Integration.test.ts`

The §13 matrix. Each test is a multi-actor scenario exercising the
full lifecycle.

- **Appendix A.1 via cascade.** Carol's full proposal end-to-end with
  Bob using `accept-cascade` rooted at *Urban Fantasy* (the cascade
  variant of the Phase-6 single-accepts walkthrough). Final live
  state matches A.1.

- **Appendix A.2 in full.** Two proposals, three reviewers; ends with
  Frank's direct detach causing Erin's nested create to become case-3
  invalid and remain in her queue. Erin then dismisses it. Final
  live state matches A.2.

- **§14 bullet 2 — collaborative deletion.** Dana owns a region that
  contains a Dana-owned shared taxon. Dana can't delete (precondition
  1 fails). Dana submits proposals to the other parents' owners to
  detach the shared taxon; they accept; Dana retries delete; now
  succeeds. Verifies that the deletion-region halt-and-detach rules
  interact correctly with the proposal layer.

- **§14 bullet 3 — ownership reassignment reroutes promotion.**
  Submission produces a latent change whose payload-parent is an
  add-create. Between submission and the parent's acceptance, the
  reviewer of the parent reassigns ownership of the parent's owner-
  to-be — wait, the parent is an add-create, so ownership is
  determined at acceptance. Reframe: latent change whose payload-
  parent is a no-op anchored on an existing taxon. The taxon's owner
  reassigns ownership to someone else (via §6.2) before the chain
  promotes. When promotion fires, the dependent routes to the *new*
  owner. This pins that promotion-time reviewer resolution sees
  current live state, consistent with the §6.2 unilateral rule.

- **§14 bullet 4 — cascade-delete detaches and invalidates.** A
  proposal queues a change whose payload-parent is an other-owned
  taxon attached to a deleter's subtree. The deleter deletes; the
  other-owned taxon is detached (§6.3 halt). The queued change's
  payload-parent still exists but is no longer in the target tree —
  case-3 external invalidation on the reviewer's next read.

- **Reset across Phase-7 lifecycle.** Build out a scenario containing
  a successful cascade, an active case-3 invalid queued change, and
  a case-2 auto-dismissed change. Call `POST /reset`. Confirm:
  registry empty, no taxa, no proposals, no queues, id counters
  restart. (Per CLAUDE.md "State reset" gate for the phase.)

- **Concurrency under the §11.1 write lock for accept-cascade.** Two
  reviewers issue cascades concurrently. They serialize; both
  observable outcomes are coherent with sequential application in
  whichever order the lock granted.

### 7. Status-view + queue projections — `phase7StatusView.test.ts`

§11.5 / §15.2 projections for the new states.

- **Proposer view shows `invalid` for all three cases.** Build one
  proposal each that lands in case 1, case 2, case 3. The
  proposer's `GET /proposals/{id}` reports `invalid` for each
  affected node, with the per-decision-10 reason wording.

- **`GET /queue` includes case-3 invalids but not case-1 or case-2
  invalids.** Verify the queue entry for a case-3 invalid carries
  its `state: "invalid"` (the §15.2 sub-state contract).

- **Cascade success leaves queue clean of the cascade's set.** All
  accepted changes are removed from the reviewer's queue; nothing
  remains tagged with the cascade root id.

## Out of scope (Phase 7 is the last phase)

Nothing is deferred to a future phase. Anything the spec leaves
undefined and not covered here is a known gap to record in the final
plan's changelog.

## Resolved spec ambiguities — quick index

1. Case-2 vs case-3 labeling — by immediately-causing actor.
2. Lazy evaluation scope — case-2 at end-of-write, case-3 on read.
3. Cascade rollback (errata E1) — full atomic.
4. Cascade frontier extends via ownership transfer (iterative).
5. Dismiss on not-queued invalid → `409 conflict`,
   `details.kind: "change_not_in_queue"`.
6. Cascade boundary at non-queued state.
7. Failed single-accept → case-2 auto-dismiss (replaces Phase-6
   placeholder).
8. Rollback restoration is byte-equal in both state and bookkeeping.
9. HTTP shapes for cascade and dismiss.
10. Reason strings for each §11.4 transition.
11. Proposer view shows only `invalid`; only `/queue` distinguishes
    case-3 from case-2.
