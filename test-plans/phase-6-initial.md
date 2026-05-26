# Phase 6 — Initial Test Plan (FROZEN)

This plan is written from the spec (`prd/prd.md` §5, §10.3, §11.2, §11.3,
§11.4 case 1, §11.5, §12.1, §12.3, §13, §14, §15.5, §15.6) and
`prd/phase-6-single-review.md` **before implementation begins**. Once any
implementation code lands, this file is frozen and must not be edited.
The phase's `phase-6-final.md` supersedes it and records what was actually
tested, with a changelog of differences.

## Scope under test

Phase 6 introduces the **single-decision review loop** on top of Phase 5's
routed-but-not-yet-acted-upon changes: a reviewer may accept or reject one
queued change at a time. Acceptance applies the change atomically against
live state (validated at §10.3 scope), promotes direct dependents from
`latent` to `queued` (or invalidates them if their existence dependencies
no longer hold), and — for `add`-create — transfers ownership of the new
taxon to the accepting reviewer. Rejection of an `add`/graft propagates
to invalidate its payload descendants per §11.4 case 1.

In scope:

- **Change states (§11.2).** The full vocabulary becomes observable in
  this phase: `latent`, `queued`, `accepted`, `rejected`, `invalid`. The
  `invalid–awaiting-dismiss` *queue sub-state* (§11.4 case 3) remains
  out of scope (Phase 7); this phase's `invalid` is always already
  dequeued.
- **Accept single (§12.1, §15.5).** `POST /changes/{id}/accept`. The
  caller must be the change's reviewer and the change must currently be
  in `queued` state. The server validates against current live state at
  the §10.3 scope by reusing the Phase-3 invariant module; on success it
  mutates live state, sets the change `accepted`, dequeues it, and runs
  promotion per §11.3. On failure (no longer valid) the change stays
  `queued` and the request returns `409` with a reason naming the
  offending taxon/edge.
- **Ownership transfer on create-accept (§5, §12.1).** Accepting an
  `add`-create makes the **accepting reviewer** the owner of the
  newly-created taxon.
- **Promotion (§11.3).** Accepting an `add`/graft change promotes its
  *direct* payload-dependents from `latent` to `queued`, provided their
  existence dependencies (no-op / rename ancestors above the dependent
  on its payload path) currently hold. Routing for the promoted change
  is resolved at promotion time:
  - `rename` dependent → owner of the renamed taxon.
  - `add` / `detach` dependent whose payload-parent is the just-accepted
    `add`-create → the **accepting reviewer** (the new owner).
  - `add` / `detach` dependent whose payload-parent is the just-accepted
    `add`-graft → owner of the grafted taxon (unchanged by graft, §9.3).
  - `add` / `detach` dependent whose payload-parent is *higher up* in
    the payload (the just-accepted change is on the path but is not the
    payload-parent of the dependent) → owner of that payload-parent
    taxon as it stands in live state.
  When a direct dependent's existence dep no longer holds, the dependent
  is marked `invalid` (it can never become queueable; the proposer's
  anchor position is gone). Promotion only fires for direct dependents
  in the payload tree; further-nested payload-descendants stay latent
  until *their* nearest add-ancestor is accepted in turn (Phase 7's
  cascade does this in one call; Phase 6 does it across multiple single
  accepts).
- **Reject (§12.3, §15.5).** `POST /changes/{id}/reject`. Reviewer-only,
  queued-only. The rejected change becomes `rejected` and is dequeued.
  When the rejected change is an `add`/graft, all of its payload
  descendants become `invalid` (§11.4 case 1) — those that were latent
  stay dequeued; any that happen to be queued (impossible for a *direct*
  descendant of an unaccepted add, but reachable via a no-op/rename
  segment between two adds — see decision #3) are dequeued. Rejection of
  a `rename` or `detach` does **not** invalidate descendants (decision
  #1).
- **Authorization (§15.5).** Both review actions go through the Phase-2
  `identityWithRegistry` + `requireWriter` chain (null → 403,
  unregistered → 403, malformed `X-Username` → 400), then check that the
  caller equals the change's `reviewer` (non-match → 403).
- **State reset (§15).** `POST /reset` continues to clear all proposal
  / change / queue state; tests confirm that accepts and rejects don't
  leave residue beyond what the Phase-5 reset already drained.

Out of scope for Phase 6 (explicitly deferred by the brief):

- **Cascade accept (§12.2, §15.5 `POST /changes/{id}/accept-cascade`)** —
  Phase 7.
- **Self-invalidation auto-dismiss (§11.4 case 2)** and **external
  invalidation pending dismiss (§11.4 case 3)** — Phase 7. In particular,
  a Phase-6 acceptance that fails validation **does not** transition the
  change to `invalid`; it stays `queued` and the request returns 409
  (decision #4 below).
- **`POST /changes/{id}/dismiss` (§12.4)** — Phase 7.
- **Lazy validity evaluation on `/queue` reads or accept attempts**
  (§11.4 last paragraph) — Phase 7.

## Resolved spec ambiguities (decided up front, recorded for traceability)

These were discussed and confirmed during planning. Each is part of what
this plan verifies.

1. **Reject-propagation scope.** §12.3's "all of its payload descendants
   become invalid (§11.4 case 1)" is read through the **§11.4 case 1
   filter**: only rejecting an `add`/graft cascades-invalidates payload
   descendants. Rejecting a `rename` leaves its payload descendants
   untouched (they had an existence-dep on the renamed taxon, which
   still exists with its old name; the rename failing doesn't break
   them). Detach is a leaf, so the question is moot for it.

2. **Acceptance-failure transition.** When acceptance fails validation in
   Phase 6, the request returns `409 conflict` with a reason and the
   change **stays `queued`**. The reviewer can retry (after live state
   changes) or reject. The case-2 (auto-dismiss) / case-3 (mark-invalid-
   but-stay-queued) transitions land in Phase 7.

3. **Promotion when an existence dep has been broken.** §11.3's "provided
   their existence dependencies also currently hold" applies. If a
   latent direct dependent's existence-dep ancestor (any `no-op` or
   `rename` ancestor above it on the payload path) no longer names a
   taxon present at that position in the target tree, the dependent is
   marked `invalid` (not promoted; not left latent — there is no path
   back to validity). Phase 6's mutation set (add edges, create taxa,
   rename taxa, detach edges) can in principle break a no-op/rename
   ancestor's existence-dep via a detach inside a cascade; but Phase 6
   has no cascade, so the *direct* invalidation-at-promotion case is
   rare in practice. It is still tested.

4. **Non-queued accept/reject.** Acting on a change that exists but is
   not in `queued` state returns `409 conflict` ("change is not in
   queued state"). 403 is reserved for "caller is not the reviewer."
   404 is for an unknown change id.

5. **HTTP shapes.**
   - `POST /changes/{id}/accept` on success → `200 OK` with body
     `{ changeId, state: "accepted" }`. (We deliberately don't return
     the full proposal status tree on each accept — the proposer
     already has `GET /proposals/{id}` for that, and other reviewers'
     queues are read independently. The minimal body keeps the
     contract stable across Phase 7's richer responses.)
   - `POST /changes/{id}/reject` on success → `200 OK` with body
     `{ changeId, state: "rejected" }`.
   - On failure both endpoints return the §15.6 envelope with the
     standard HTTP status mapping.

6. **Reviewer of a promoted change is resolved at promotion time, not
   at submission.** Phase 5's `Change` carried a `reviewer` field that
   was `null` for latent changes whose payload-parent was an add-create
   (the new owner was unknown at submission). When such a latent
   becomes queued via promotion, the reviewer is filled in then. Latent
   renames already had a known reviewer at submission (the renamed
   taxon's owner, recorded by Phase 5); promotion uses that without
   change.

7. **`reason` on negative dispositions.** §11.5 allows an optional
   human-readable reason on `rejected` / `invalid` nodes. In Phase 6:
   - `rejected` nodes are direct consequences of a reviewer action; the
     status view shows `disposition: "rejected"` and may omit `reason`
     (the proposer's view doesn't currently need to distinguish "why
     rejected" beyond "the reviewer rejected it"). We do **not** set
     `reason` on a plain reject.
   - `invalid` nodes that result from rejection-propagation carry
     `reason: "ancestor <changeId> was rejected"` (referencing the
     causing add/graft change id) so the proposer can correlate.
   - `invalid` nodes that result from promotion-time existence-dep
     failure carry `reason: "existence dependency <taxonId> is no
     longer in target tree"`. (Both reasons are short, programmatic-
     friendly strings; the exact prose is tested only for the offender
     id appearing.)

8. **Change-state coherence across endpoints.** After a successful
   accept/reject of change `c`, the following all agree on `c`'s state:
   - `GET /proposals/{p}` (proposer view) shows `c`'s disposition as
     `"accepted"` or `"rejected"`.
   - `GET /queue` for the (former) reviewer no longer contains `c`.
   - For accept: live state reflects the mutation; for reject: live
     state is unchanged.

9. **Latent renames already carry a known reviewer.** A practical
   consequence of #6 plus the Phase 5 implementation. Phase 6 promotion
   re-resolves the reviewer for adds and detaches; for renames it just
   uses the recorded value (which is still correct because the renamed
   taxon's owner is a global property of the taxon, not of the proposal
   context).

10. **No mutation on a failed accept.** When `evaluateAll` flags a
    violation against the candidate state, the tentative mutation is
    rolled back and live state is byte-equal to its pre-call value.
    Tests assert this both via `GET /trees/{root}` and `GET /taxa`
    snapshots taken before and after a failing accept.

## Coverage dimensions (per the brief)

The brief enumerates three coverage dimensions for this phase. Each maps
to the test groups below:

- **New behavior** — single accept, single reject, promotion on accept
  (with ownership transfer for `add`-create), and rejection-propagation
  for `add`/graft. Boundary cases where a rule's outcome flips
  (validates vs. doesn't; promotes vs. invalidates) live in groups 1–5.
- **Interactions with earlier phases** — acceptance applies real
  mutations through the same fixture primitives that direct actions use,
  so it interacts with §3.3 invariants, ownership, and multi-tree
  shared-taxon behavior. Groups 2, 3, 6, and 7 build multi-owner /
  multi-tree state and exercise the loop against it.
- **Failure and invalid states** — acceptance-time validation failures
  (cycle, in-tree duplicate, in-tree name clash within the target tree,
  in-tree name clash within **another** containing tree for a rename or
  graft), and the rejection-propagation cascade. Group 2 (rename
  validations), group 3 (add/graft validations), and group 5 (rejection
  propagation) carry the bulk; group 4 covers promotion-time existence-
  dep failure.

### §14 accepted properties verified in this phase

- **Non-atomic moves** (§14 bullet 1) — Appendix A.2 is now executable
  end-to-end up to the point where Frank accepts the graft and Dana
  rejects the detach (Frank's direct detach of `a3` from `b2` is a
  §6.4 action already supported in Phase 4 — but its effect on Erin's
  latent-then-promoted-then-externally-invalidated *Unreliable
  Narrator Thriller* lives in §11.4 case 3, which is Phase 7). For
  Phase 6 we walk Appendix A.2 up to the point where the *shared*
  outcome materializes (a3 reachable from both `a2` and `b2`).
- **Graft preserves ownership** (§9.3 / Appendix A.2 narrative) —
  acceptance of the graft does not transfer the grafted taxon's owner
  to the accepting reviewer; verified by reading the taxon's owner
  after acceptance.
- **Cascade-frontier expansion via nested creates** (§11.3 / §13) — a
  create nested under a create (the Appendix A.1 *Paranormal Romance*
  shape) becomes queueable only when the outer create is accepted.
  Phase 6 lets us actually accept the outer (Bob accepts *Urban
  Fantasy*) and then assert *Paranormal Romance* is queued (to Bob,
  the new owner, per the ownership-transfer rule).
- **Ownership-reassignment is unilateral** (§14 bullet 3) is a
  consequence of §6.2 already covered by Phase 4. We re-touch it here
  only insofar as create-acceptance is an implicit ownership
  assignment to the accepting reviewer.

## Test groups

File names are nominal; the implementation may split or merge as long as
the listed scenarios are covered. Per the Phase-5 convention, a shared
`test/proposalsTestHelpers.ts` carries the boilerplate; new helpers for
accept / reject calls join it.

### 1. Accept happy paths — `acceptHappy.test.ts`

Smoke-tests that each op accepts end-to-end and produces the documented
live-state effect.

- **`rename`** accept:
  - Setup: Alice owns root `r1`, name "Fiction". Bob (proposer)
    submits a proposal anchored at `r1` with `rename r1 → "Speculative
    Fiction"`. (Alice owns `r1`, so the rename routes to Alice.)
  - Alice accepts the change. Response `200` with
    `{ changeId, state: "accepted" }`.
  - `GET /taxa/r1` now reports name `"Speculative Fiction"`; owner
    unchanged.
  - Alice's `/queue` no longer contains the change.
  - `GET /proposals/{id}` shows the change's disposition as
    `"accepted"`.
- **`add`-create** accept (ownership transfer):
  - Setup: Alice owns `r1`. Bob submits anchored at `r1` with a
    nested `add`-create `"Fantasy"` under `r1`. (`r1`'s owner is the
    reviewer.)
  - Alice accepts. The new taxon is created with **Alice** as owner
    (decision: ownership transfer). It appears as a child of `r1` in
    `GET /trees/r1`. `GET /taxa/{newId}` confirms `owner: "Alice"`.
  - Alice's `/queue` no longer contains the change.
- **`add`-graft** accept (no ownership transfer):
  - Setup: Frank owns root `b1` → `b2`. Erin owns `a3` (a separate
    tree, sole root). Grace submits a graft of `a3` under `b2`.
    (Routes to Frank.)
  - Frank accepts. `a3` is now a child of `b2` in `GET /trees/b1`,
    AND `a3` remains a root of its original tree (so `a3` is now
    shared across two trees). `GET /taxa/a3` reports `owner:
    "Erin"` — ownership is **unchanged**.
- **`detach`** accept:
  - Setup: Alice owns `r1` → `c1` (Alice). Bob submits a proposal
    anchored at `r1` with nested `detach c1`. Routes to Alice
    (parent owner).
  - Alice accepts. `c1` is no longer a child of `r1`; `c1` survives
    as a root (it had no other parents). `GET /trees` now lists
    `c1` as a root.

For each happy-path accept above: the proposer's `GET /proposals/{id}`
reflects `disposition: "accepted"` on the accepted node, with the
correct (server-assigned) `changeId`.

### 2. Rename-acceptance validation — `acceptRenameValidation.test.ts`

§10.3 — rename must satisfy the per-tree-name-uniqueness invariant in
**every** tree containing the renamed taxon. The invariant module
already enumerates all trees; this group asserts the cross-tree path is
exercised at acceptance time.

- **In-tree name clash in the target tree** → `409`. Setup: Alice owns
  `r1` with two children, "Fantasy" and "Mystery". Bob submits
  `rename Mystery → "Fantasy"`. Alice accepts → 409 conflict with
  details naming the clashing taxa and the tree root. Change stays
  queued; live state unchanged (the second taxon still named
  "Mystery").
- **Name clash in **another** containing tree** → `409`. Setup: Alice
  owns `r1` ("Fiction") with child `c1` ("Fantasy"); Alice also owns
  `r2` ("Genre Index") with child `c2` ("Suspense"). Alice attaches
  `c1` under `r2` as well (so `c1` is shared between trees `r1` and
  `r2`). Bob submits `rename c1 → "Suspense"`. The rename would be
  fine in `r1` but clashes with `c2` in `r2`. Alice accepts → 409
  with the clash details naming **`r2`** (the *other* tree).
- **Trivially-valid rename across two trees** → `200`. Same shape as
  above but the new name doesn't clash anywhere; acceptance succeeds
  and `c1` is renamed in both trees simultaneously (verified by
  reading `c1`'s name and the structure of both `r1` and `r2`).
- **No-op rename** (rename to same name) → succeeds; live state
  unchanged. (Not a violation under case-insensitive comparison.)

### 3. Add-acceptance validation — `acceptAddValidation.test.ts`

§3.3 invariants 1, 2, and 3 for `add`-create and `add`-graft, evaluated
against the full containing tree(s) of the (post-graft) state.

For `add`-graft:

- **Cycle** → 409. Setup: a1 → a2 → a3. Submit graft `a1` under `a3`.
  Routes to a3's owner. Accept → 409 cycle. State unchanged.
- **In-tree duplicate (diamond within one tree)** → 409. Setup: r1 →
  c1, c2; Bob owns c1. Submit graft `c1` under `c2`. Accept → 409
  in-tree duplicate (r1 reaches c1 via two paths).
- **In-tree name clash in target tree** → 409. Setup: r1 has child
  "Fantasy" (c1); a separate root r2 has child "Fantasy" (c2, owned
  by someone with attach rights). Graft c2 under r1 (whose owner is
  the reviewer). Accept → 409 name clash within r1.
- **Name clash in the grafted taxon's own subtree against the target
  tree** → 409. Setup: tree T1 root r1 has child "Mystery" (m1).
  Tree T2 root b1 has child "Suspense" (s1) which itself has a
  grandchild "Mystery" (m2). Submit graft of `s1` under `r1`.
  Accepting would bring `m2` into r1 and clash with the existing
  `m1` ("Mystery"). 409 with details naming `m1`/`m2` in r1.
- **Happy graft across trees** → 200. State now shows the grafted
  taxon as shared.

For `add`-create:

- **Name clash with existing sibling in the target tree** → 409.
  Setup: r1 has child "Fantasy". Submit `add`-create "Fantasy" under
  r1. 409.
- **Case-insensitive clash** → 409. r1 has child "Fantasy"; create
  "FANTASY" → 409 (per §3.4 case-insensitive comparison).
- **Happy create at root level** — create a new child under a tree
  with no other "Fantasy". Confirms 200, ownership transfer, edge
  added.

For each failure case: the change stays in `queued` state; the live
state is byte-equal pre/post (`GET /trees/{root}` snapshots match).

### 4. Promotion — `promotion.test.ts`

§11.3 latent→queued boundary. Promotion happens only on accept of
`add`/graft; this group exercises every variation of who the promoted
change's reviewer turns out to be.

- **Create → nested create promotes to accepting reviewer**
  (Appendix A.1 — *Paranormal Romance* under *Urban Fantasy*). Bob
  is reviewer of the outer Urban Fantasy create. He accepts. The
  inner Paranormal Romance create was latent and routed to "owner
  of payload-parent = Urban Fantasy" — which only existed after
  acceptance. Promotion resolves the new payload-parent's owner =
  Bob, and Paranormal Romance is now in Bob's queue with
  `disposition: "queued"`.
- **Create → nested rename promotes to taxon owner (which equals
  accepting reviewer)**. Submit a create + nested rename of an
  existing taxon Z. If Z is owned by Carol, the rename routes to
  Carol regardless of who accepts the outer create — verify the
  promoted rename goes to Carol's queue.
- **Graft → nested add promotes to the grafted taxon's owner** (not
  the graft's accepter). Setup: Frank reviews the graft of Erin's
  `a3`; nested under the graft is an `add`-create. Promotion routes
  the nested create to **Erin** (a3's owner — unchanged by graft).
- **Graft → nested detach promotes to the grafted taxon's owner**.
  Same shape as above but with a detach of a child of `a3`.
- **Add → nested rename routes to the renamed taxon's owner** (pre-
  recorded at submission; promotion just unlatches it without
  resolving anything new).
- **Add → only direct dependents promote.** Two levels of nested
  create: `add A` → `add B` → `add C` (path-wise). When A is
  accepted, **only B** becomes queued; C stays latent because B
  (its decision-dep ancestor) hasn't been accepted yet. Then B is
  accepted → C becomes queued.
- **Add → sibling dependents promote independently.** `add A` has
  two operative children (a rename of an existing taxon and an
  `add`-create). Both become queued in submission (change-id)
  order.
- **Promotion does not affect sibling subtrees.** Two latent
  branches under two different parent adds; accepting one does not
  promote the other's children.
- **Queued order on promotion.** The promoted change appears at the
  **end** of its (new) reviewer's queue (subsequent reads return it
  after previously-queued changes for that reviewer). Tested by
  pre-loading the reviewer with another queued change first.

Promotion-time existence-dep failure (decision #3):

- **Existence dep broken between submission and acceptance** →
  invalid. Setup: a1 → a2 → a3 (a1 root). Submit a proposal
  anchored at a1 with: `no-op a1` / `no-op a2` / `add`-graft (some
  taxon X) under a2 / nested under the graft: `rename a3 → ...`.
  Wait — actually the cleanest shape: anchor at a1, `no-op a2`,
  under that an `add`-create. Before the create is accepted, the
  parent owner deletes a2 directly. Then when the graft (oh wait
  this is getting tangled — let me restructure). Cleaner: the
  shape `add` under a1 promotes a `rename` under the add — but the
  *rename's* existence dep is the create's *own* result, so we
  need a setup where the existence dep is *outside* the add's
  subtree. Use this shape instead: top no-op at r1; nested no-op
  at c1 (c1 is a child of r1); under c1, an `add`-create. Before
  acceptance, Carol (owner of r1) directly detaches c1 from r1.
  When the reviewer attempts to accept the add, the add's *own*
  existence dep is broken — covered by group 2 (acceptance fails).
  This isn't quite the promotion case.

  The clean promotion-time existence-dep failure shape is:
  - Top no-op at `r1`. Nested `add`-create `X` under `r1`. Nested
    under `X`: a `rename` of an *existing* taxon `Q` (not in `r1`,
    perhaps in another tree the reviewer accepts the graft from —
    actually this is also tangled because rename's existence dep
    is just that Q exists, not its position).
  - Simplest: anchor at `r1`. Nested `add`-graft of an *existing*
    taxon `Y` under `r1` (Y in another tree T2). Nested under the
    graft: `no-op Y` (existence dep that Y is at the post-graft
    position) → nested under that: `add`-create. Direct dep:
    accepting the graft promotes the no-op (no, no-op is
    structural, not a change). OK the no-op doesn't make a change
    but it does enforce an existence dep on the inner create.
  - Cleanest realizable case: anchor at `r1`. `add`-graft of `Y`
    under `r1`. Nested under the graft: `rename` of a CHILD of Y
    (say `y_child`). The rename's existence dep is that
    `y_child` is in the target tree post-graft. Before the graft
    is accepted, an external action (someone with rights)
    directly detaches `y_child` from `Y` in `Y`'s original tree.
    Now when the graft is accepted, `y_child` is no longer
    reachable in `r1` post-graft. The rename's existence dep
    fails → invalid.
  - This works. Test: the promoted rename is `invalid` (not
    queued, not latent) immediately after the graft is accepted.
    `GET /proposals/{id}` shows `disposition: "invalid"` with a
    `reason` naming `y_child`. The reviewer's queue contains the
    graft as accepted (well, dequeued) but not the rename.

  If during implementation this shape proves impractical to
  construct reliably, the final plan will record an alternative
  shape (and the changelog will explain why).

### 5. Reject — `reject.test.ts`

§12.3 reject + §11.4 case 1 propagation (decision #1 filter applies:
only `add`/graft rejection propagates).

Basic reject of each op:

- **Reject a rename** — Alice reviews; she rejects. Response 200 with
  `{ changeId, state: "rejected" }`. Live state unchanged
  (`GET /taxa/{id}` reports the original name). Alice's queue no
  longer contains the change. `GET /proposals/{id}` shows
  `disposition: "rejected"` on that node and **no change** to any
  descendant nodes' dispositions.
- **Reject a detach** — analogous. Edge still present after reject.
- **Reject an add-create with NO nested ops** — change goes
  `rejected`; live state unchanged (no taxon created).
- **Reject an add-graft with NO nested ops** — change goes
  `rejected`; live state unchanged (no edge added).

Rejection-propagation (decision #1):

- **Reject add-create with nested create** → outer is `rejected`,
  inner (latent) is `invalid` with `reason: "ancestor <changeId>
  was rejected"`. Inner was not in any queue; the reject doesn't
  need to dequeue it.
- **Reject add-graft with mixed nested ops** — graft has a nested
  create, a nested rename of an existing taxon (latent under the
  graft), and a nested detach. All three become `invalid`. None
  were queued (all were latent under the graft).
- **Multi-level cascade on reject** — outer `add`-create → inner
  `add`-create → innermost `rename`. Rejecting the outer
  invalidates BOTH inner and innermost.
- **Rejection of rename DOES NOT invalidate descendants** (decision
  #1 keystone). Setup: top no-op anchor; nested `rename` of taxon
  X; under the rename, a nested `add`-create. The nested create is
  latent under the rename? Wait — rename is an *existence* dep, not
  a decision dep. So the nested create's path includes no add
  ancestor and it is **queued** at submission. The reviewer of the
  rename rejects → the rename is `rejected`, but the nested create
  stays `queued` (because it didn't depend on the rename's
  acceptance, only on the renamed taxon's existence — which still
  holds). Verifies that decision-#1's filter actually operates.
- **Rejection of detach** — detach is a leaf, so no descendants to
  propagate to. Confirmed: a single change goes rejected; the
  proposal's other (sibling) changes are untouched.

Rejection + queue interleaving:

- **A queued descendant of a rejected add gets dequeued on
  invalidation.** Constructable shape: nested `add` (decision dep)
  under another `add` — both routed to the same reviewer, but
  Phase 6 has no cascade so they must be accepted separately.
  After accepting the outer add, the inner is now queued. If the
  outer is then *rejected*... wait, the outer is already
  `accepted`, not queued, so reject is impossible. The cleaner
  shape: nested `add` (latent) becomes `invalid` on reject; it was
  never queued so there's nothing to dequeue — covered above.

  The "queued descendant of a rejected change gets dequeued"
  shape requires a chain that doesn't actually arise from the
  rules (a queued descendant of a still-queued add is impossible
  because the queued descendant by definition has no
  unaccepted-add ancestor). We assert non-existence: after a
  reject, no reviewer's queue contains any invalidated change.

### 6. Authorization & state guards — `reviewAuth.test.ts`

The composition of identity, writer, reviewer-match, and queued-state
guards on both endpoints.

For each of `POST /changes/{id}/accept` and `POST /changes/{id}/reject`:

- Null `X-Username` → `403 forbidden` (`requireWriter`).
- Unregistered well-formed `X-Username` → `403`
  (`identityWithRegistry`).
- Malformed (NBSP-prefixed) `X-Username` → `400 validation_error`
  (`parseUsername`).
- Unknown change id → `404 not_found`.
- Caller is registered but is not the change's reviewer → `403
  forbidden`. (Tested for both: caller is a different registered user;
  caller happens to be the proposer but not the reviewer.)
- Caller is the reviewer but the change is in state ≠ `queued`:
  - Already `accepted` → `409 conflict`.
  - Already `rejected` → `409`.
  - `latent` → `409` (the reviewer is the renamed-taxon's owner, the
    change exists but the routing hasn't promoted it yet because of
    a decision-dep ancestor).
  - `invalid` → `409`. Constructed via reject-propagation from
    group 5.

For each error path: HTTP status matches §15.6 mapping; envelope shape
`{ error: { code, message, details? } }` with the expected `code`.

### 7. Cross-phase integration — `reviewIntegration.test.ts`

End-to-end stories that combine multiple ops across multiple reviewers.

- **Appendix A.1 walkthrough (single-accepts, no cascade).** Build the
  Alice/Bob multi-owner tree. Carol submits the A.1 proposal. Then:
  1. Bob accepts the `c3` rename → live state shows `c3` as
     "High Fantasy".
  2. Bob accepts the *Urban Fantasy* create → new taxon owned by
     Bob, attached under `c2`. *Paranormal Romance* promotes to
     queued (in Bob's queue).
  3. Bob accepts *Paranormal Romance* → new taxon owned by Bob,
     attached under the new Urban Fantasy taxon.
  4. Alice accepts the `c1` rename → `c1` is now "Speculative and
     Imaginative Fiction".
  - Final live state matches Appendix A.1's "Final live state"
    block (modulo server-assigned ids for the two new taxa).
  - Carol's `GET /proposals/{id}` shows every node `accepted`
    (operative) or `structural` (no-ops).
  - Reorderings: also run a variant where Alice's `c1` rename
    accepts first (the rename is queued from the start). Final
    state is the same.
- **Appendix A.2 partial walkthrough.** Build T1 (Dana/Erin) and T2
  (Frank). Grace submits P1 (detach a3 from a2) and P2 (graft a3
  under b2 with nested create).
  - Frank accepts P2's graft. Now `a3` is shared across T1 and T2;
    `a3`'s owner is still Erin. *Unreliable Narrator Thriller*
    promotes to queued — in Erin's queue (a3's owner, the new
    payload-parent).
  - Dana rejects P1's detach → P1's detach is `rejected`; live
    state unchanged (a3 stays under a2). The intended "move" has
    landed partially (a3 is now shared) — §14 bullet 1.
  - Erin's queue still contains the *Unreliable Narrator
    Thriller* create (this is the Phase-6-observable slice of A.2;
    the Phase-7 dismissal-after-external-invalidation tail comes
    later).
- **Acceptance failure does not leave residue.** Build a state
  where a rename will fail (clash). The reviewer attempts accept
  → 409. Then the rename is rejected → 200, `rejected`. Final
  proposal status: rejected. No mutation occurred; the
  same-reviewer's other queued changes are unaffected.
- **Cross-tree rename via shared taxon.** A shared taxon between
  two trees is renamed via a single rename change; the rename's
  reviewer (the owner) accepts; both trees see the new name in
  `GET /trees/{root}`. Verifies §10.3 cross-tree behavior
  positively (not just as a violation).
- **Self-routed accept.** Alice owns a tree she submits a
  proposal about; her own queue contains the change; she accepts;
  the change is `accepted` and her live state mutates. Confirms
  that self-routing (Phase-5 decision #12) flows into Phase-6
  acceptance without special-casing.
- **Reset across the lifecycle.** Submit, accept, reject, then
  `POST /reset`. Re-bootstrap (register users, rebuild a small
  tree, submit a fresh proposal). The fresh proposal's `id` is
  `p1` (counter restart) and fresh change ids start at `c1`
  (counter restart). No accepted-or-rejected residue is
  observable (`GET /proposals` is empty pre-reset, then contains
  only the new proposal post-reset). Inherited from Phase 5; this
  test adds the accept/reject-step coverage.

### 8. Status view rendering — folded into `reviewIntegration.test.ts`

The Phase-5 `proposalsStatusView.test.ts` already pins the §11.5
isomorphism rules and the structural shape; Phase-6 dispositions are
already in its `Disposition` union. This phase's integration tests
exercise the **populated** values:

- `accepted` disposition appears on accept; verified in the A.1
  walkthrough.
- `rejected` disposition appears on reject; verified in the A.2
  walkthrough.
- `invalid` disposition appears via rejection-propagation; verified
  in group 5.
- `reason` field appears (and only appears) on `invalid` nodes; its
  content references the causing change id (for case 1
  propagation) or the missing taxon id (for promotion-time
  existence-dep failure).

If a dedicated status-view-Phase-6 test file proves cleaner during
implementation, it will be added to the final plan and recorded in
the changelog.

### 9. Reset clears review state — folded into `proposalsReset.test.ts`

Phase 5's reset suite already pins the proposal-clearing contract. The
Phase-6 contract additions:

- After accept(s) and reject(s) run, `POST /reset` still produces an
  empty `GET /proposals`, empty `GET /queue` for every user, and
  fresh counters.
- Live state mutated by accepted changes is **also** cleared by
  reset (this is already covered by Phase 4's reset coverage of
  taxa, but we re-touch it here in a single integration smoke to
  confirm the chained effect).

### 10. Write serialization — covered by `writeSerialization.test.ts`

Phase 6 re-uses the §11.1 lock for both new endpoints. One new
assertion is added to that suite:

- Two `POST /changes/{id}/accept` calls dispatched against the same
  reviewer in the same tick produce a deterministic, serialized
  ordering of effects — the second observes the first's mutation
  before deciding validity. Phase 6's only practical observable is
  that two simultaneous, *both individually valid* accepts produce
  consistent state (no torn writes; both reflected in live state
  and both marked `accepted`).

## §15.6 envelope round-trips — folded into the per-op suites

Each error-path test in this plan asserts:

- HTTP status matches the §15.6 mapping (400 / 403 / 404 / 409).
- Response body is the envelope `{ error: { code, message, details? } }`
  with the expected `code`.
- Where 409 is used for an invariant violation (group 2, group 3),
  `details` carries a structured offender (the violating taxon ids and
  the tree root) so a client can react programmatically — mirroring
  Phase 4's `conflictFromViolation` shape.

This mirrors how Phases 2–5 distributed envelope-shape assertions
across the endpoint suites.

## Out of scope (deferred to later phases)

- `POST /changes/{id}/accept-cascade` (§12.2, §15.5) → Phase 7.
- `POST /changes/{id}/dismiss` (§12.4, §15.5) → Phase 7.
- §11.4 case 2 (self-invalidation auto-dismiss) → Phase 7.
- §11.4 case 3 (external invalidation that stays queued pending
  dismissal) → Phase 7. In particular, the `invalid–awaiting-dismiss`
  queue sub-state called out by §15.2's `/queue` description is
  unreachable in Phase 6.
- Lazy validity re-evaluation on `/queue` reads (§11.4 last paragraph)
  → Phase 7. In Phase 6, validity is evaluated only at the moment of
  the accept attempt.
- The Phase-6 acceptance-failure path returning `409` and leaving the
  change `queued` is a deliberate placeholder; Phase 7 will replace
  it with the proper case-2/case-3 state transitions.

## Notes on test mechanics (per the toolchain supplement)

- Tests use `node:test` and `node:assert/strict`; no third-party
  framework or assertion helper.
- Tests live under `test/`, are named `*.test.ts`, are compiled by
  `tsc`, and run via `node --test "dist/**/*.test.js"`.
- HTTP-level tests use `app.request(...)` against an in-process Hono
  app (no port binding).
- Per-test isolation: `POST /reset` runs before each test that touches
  server state; users are then explicitly registered as the test needs.
  No test depends on a specific server-assigned ID — ids (taxa,
  proposals, changes) are captured from response bodies and referred
  to by variable.
- Malformed-`X-Username` cases use NBSP (U+00A0) per the Phase-2 /
  Phase-4 final-plan note on HTTP OWS stripping.
- Names in tests draw from `prd/sample-taxonomy.md` (non-normative)
  where convenient — "Fiction", "Fantasy", "Epic Fantasy", "Urban
  Fantasy", "Paranormal Romance", "Psychological Thriller", etc. —
  and fabricate fresh names where the sample doesn't cover a needed
  shape. The Appendix A.1 / A.2 fixtures intentionally re-use the
  appendix names so the worked examples are testable verbatim
  (modulo Phase-5 decision #1).
- Where a test needs a pre-existing graph that Phase-4 writes can build
  themselves, it builds via those writes. Phase-5's
  `proposalsTestHelpers.ts` is extended with `acceptChange(app,
  caller, changeId)` and `rejectChange(app, caller, changeId)`
  wrappers; the existing `submitOk`, `register`, `createTaxon`,
  `attach`, and `reassignOwner` helpers are unchanged.
