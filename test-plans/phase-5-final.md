# Phase 5 — Final Test Plan

This supersedes `phase-5-initial.md` (frozen). It records what was actually
tested, with a changelog of how it differs from the frozen initial plan and
the reason for each change.

## Run command

```
npm test                 # tsc && node --test "dist/**/*.test.js"
```

Or, equivalently:

```
npx tsc
node --test "dist/**/*.test.js"
```

**402 tests total, all passing** (287 inherited from Phases 1–4; 115 new in
Phase 5).

## Resolved spec ambiguities (recorded for traceability)

Carried over from `phase-5-initial.md` (unchanged):

1. Body field is `topTaxonId`, not `topNodeId` (Appendix A.1 typo).
2. `payload.id` must equal `topTaxonId` (mismatch → 400).
3. Submission-time existence: every payload `id` naming an existing taxon
   (non-create-add) must reference a known taxon → 404 if missing.
4. `topTaxonId` exists but not reachable from `targetRootId` → 409 (PRD
   §9.2 precondition); unknown id → 404.
5. `targetRootId` validation: unknown → 404, not-a-root → 409.
6. `POST /proposals` 201 body = `{ id, proposer, targetRootId, topTaxonId,
   payload }` — same shape as `GET /proposals/{id}`.
7. Disposition values: `latent | queued | accepted | rejected | invalid`
   on operative changes; `structural` on no-op nodes. In Phase 5 only
   `latent`, `queued`, and `structural` appear.
8. Status-node shape: `{ op, id, name?, children?, changeId, disposition,
   reason? }` for operative nodes; `{ op:"no-op", id, children?,
   disposition:"structural" }` for structural nodes. No `changeId` on
   no-op; no `reason` in Phase 5.
9. Change IDs: `c1, c2, …` server-assigned; `POST /reset` restarts to
   `c1`. Proposal IDs: `p1, p2, …` likewise.
10. `GET /proposals` list shape `{ proposals: [<summary>...] }`;
    `?proposer=<name>` filter is case-insensitive via registry canonical
    form; unknown filter → `{ proposals: [] }` (200).
11. `GET /queue` entry shape: `{ changeId, proposalId, op, targetRootId,
    state, taxonId?, name?, payloadParentTaxonId? }`. State is `"queued"`
    in Phase 5. Queue order is submission (change-id) order.
12. Self-routed proposals allowed (proposer = reviewer when she owns the
    targeted taxon).
13. Validation precedence (mirrors Phase-4 #5): identity → body parse →
    resource lookup (404) → body field validation (400) → preconditions
    (409). No post-state invariant check in this phase (acceptance-time
    per §10.3, deferred).
14. Unknown keys in proposal/payload nodes are ignored (mirrors Phase-4
    PATCH lenience).
15. Reset clears proposals + queues + change-id counter; the §4 exemption
    on `/reset` is preserved.

## What is tested

Files mirror the test groups in the initial plan one-to-one, matching the
Phase-1–4 convention.

- `proposalsParse.test.ts` — body envelope, per-op schema, top-taxon
  constraints, existence check, auth (49 tests).
- `proposalsRouting.test.ts` — per-op routing under multi-owner shapes
  (9 tests).
- `proposalsDependencies.test.ts` — §10.2 classification observable via
  status dispositions (9 tests).
- `proposalsDisposition.test.ts` — §11.3 latent/queued boundary cases +
  queue-vs-disposition coherence (6 tests).
- `proposalsPartialPayload.test.ts` — §9.1 partial-payload rule (3 tests).
- `proposalsStatusView.test.ts` — §11.5 isomorphism + access control
  (9 tests).
- `proposalsList.test.ts` — `GET /proposals` + filter (8 tests).
- `queueRead.test.ts` — `GET /queue` (11 tests).
- `proposalsReset.test.ts` — `/reset` clears Phase-5 state (6 tests).
- `proposalsIntegration.test.ts` — multi-step end-to-end stories
  (4 tests).
- `writeSerialization.test.ts` — one new test added (proposal/change ids
  ordered under the lock).

Phase 1–4 files are unchanged and still pass (287 inherited tests).

### 1. Parsing & body validation — `proposalsParse.test.ts` (49)

- Body envelope: invalid JSON, non-object body (5 variants), missing each
  of `targetRootId` / `topTaxonId` / `payload`, wrong types for each,
  unknown extra top-level keys ignored.
- Per-op schema: each op accepted in a valid position; invalid `op`
  values (4 variants); missing/wrong-type `id`; `rename` requires name
  with name-format checks (4 variants); `add` requires `id` key (missing
  ≠ null); `add`-create requires name with name-format; `add` non-null
  non-string id; `detach` leaf rule; `detach` requires id; `children`
  must be array; child entries must be objects; unknown extra payload-
  node keys ignored.
- Top-taxon constraints: top op = add / detach → 400; `payload.id` ≠
  `topTaxonId` → 400; topTaxonId unknown → 404; topTaxonId exists but
  not in target tree → 409 (with `details.kind: "top_not_in_tree"`).
- `targetRootId` validation: unknown → 404; not-a-root → 409 (with
  `details.kind: "not_a_root"`).
- Submission-time existence: nested rename / detach / graft / no-op with
  unknown id → 404 (each).
- Authorization: null → 403, unregistered → 403, malformed (NBSP)
  X-Username → 400.

### 2. Routing — `proposalsRouting.test.ts` (9)

- `rename` routes to the renamed taxon's owner; the parent's owner does
  not see it.
- `detach` routes to the payload-parent's owner; the detached child's
  owner does not see it.
- `add`-create routes to the payload-parent's owner.
- `add`-graft routes to the payload-parent's owner, not the grafted
  taxon's owner.
- `no-op` produces no change in any queue.
- §10.1 keystone: a rename(C) + nested add under C — both route to C's
  owner; the parent owner does not see either.
- Variant of the keystone with a third owner to pin "ops nested under a
  taxon route per the payload-parent rule".
- Graft preserves ownership: nested ops under a graft route to the
  grafted taxon's owner (Appendix A.2's Erin/Frank shape).
- Proposer is not auto-reviewer of her own proposal unless she happens
  to own a targeted taxon.

### 3. Dependency classification — `proposalsDependencies.test.ts` (9)

- Nested add under add-create → latent.
- Nested add under add-graft → latent.
- Nested rename under add-create → latent (path-based, not
  target-based — the renamed taxon already exists).
- Nested detach under add-graft → latent.
- Nested add under top **rename** → queued (rename is existence dep
  only, the §11.3 keystone).
- Stacked renames in a chain → all queued.
- Nested detach under no-op anchor → queued.
- Appendix A.1 verbatim: rename(c1) queued, rename(c3) queued, *Urban
  Fantasy* create queued, *Paranormal Romance* latent.
- Top no-op is structural; every operative path includes it.

### 4. Disposition boundary cases — `proposalsDisposition.test.ts` (6)

- Exactly one decision-dep ancestor → latent.
- Two decision-dep ancestors → latent (any add suffices).
- Deep no-op/rename chain → terminal change queued.
- Sibling ops don't gate each other (add sibling doesn't gate rename
  sibling).
- No-op payload node is structural, carries no `changeId`.
- Queue-vs-disposition coherence: every queued change appears once,
  every latent change appears zero times, summed across all reviewers.

### 5. Partial-payload — `proposalsPartialPayload.test.ts` (3)

- Listing only one of three children leaves the others unmentioned and
  produces no change about them.
- Partial payload + nested detach: only the detached child appears in
  the change set; siblings are untouched.
- A non-existent child id in the payload is a 404, distinguishing
  "leniency about unlisted" from "lenience about non-existent".

### 6. Status view — `proposalsStatusView.test.ts` (9)

- Isomorphism on Appendix A.1 shape: 6 nodes total, parent/child
  relationships intact.
- Every operative node has a `changeId`; every no-op has none and is
  `"structural"`.
- Submitted op/id/name fields echoed; unknown keys dropped.
- Disposition is one of the six allowed strings.
- `reason` is absent in Phase 5 (no rejection/invalidation).
- Read access: null caller + non-proposer registered caller both can
  read.
- Unknown id → 404.
- Malformed X-Username → 400.
- `POST /proposals` body's payload equals subsequent `GET /proposals/{id}`
  payload (byte-equal modulo the trivial server-assigned change ids —
  asserted both with and without stripping the ids).

### 7. List — `proposalsList.test.ts` (8)

- Empty server → empty list.
- One proposal → one summary with all expected fields.
- Multiple proposals → in submission order.
- `?proposer=alice` → only Alice's.
- `?proposer=ALICE` → case-insensitive via registry canonical form;
  canonical casing preserved in the response.
- `?proposer=unregistered` → empty list (200).
- Null caller may read.
- Malformed X-Username → 400.

### 8. Queue — `queueRead.test.ts` (11)

- Auth: null → 200 empty list, unregistered → 403, malformed → 400.
- Registered caller with no incoming → empty.
- Queued rename entry shape (taxonId + name, no parent field).
- Queued add-create entry shape (name + parent, no taxonId).
- Queued add-graft entry shape (taxonId + parent, no name).
- Queued detach entry shape (taxonId + parent, no name).
- §10.1 keystone routed correctly per-reviewer; no cross-talk.
- Latent changes are never in any queue.
- Queue order is change-id (submission) order.

### 9. Reset — `proposalsReset.test.ts` (6)

- `/reset` clears the proposals registry.
- `/reset` clears every reviewer's queue.
- `/reset` restarts the proposal-id AND change-id counters at p1/c1.
- `/reset` is still §4-exempt for the null caller.
- `/reset` is still §4-exempt for malformed-header callers.
- Post-reset, the proposal subsystem is fully usable end-to-end.

### 10. Integration — `proposalsIntegration.test.ts` (4)

- Appendix A.1 walkthrough up to submission: Alice/Bob queues +
  Carol-empty + Paranormal Romance latent and queueless.
- Appendix A.2 two-proposal cross-tree move: P1 to Dana, P2 to Frank,
  Erin queueless (nested create latent), both proposals visible and
  independent.
- Self-routed proposal: change appears in proposer's own queue.
- Reset across the lifecycle: ids restart, no pre-reset residue.

### 11. Write serialization addendum — `writeSerialization.test.ts` (+1)

- Three `POST /proposals` calls dispatched in the same tick produce
  monotonically ordered proposal ids AND change ids — the lock catches
  the new write path the same way it caught Phase-4 writes.

## §14 accepted properties verified in this phase

The brief instructs us to treat §14 as intended behavior. Phase 5
exercises three properties in their submission-time slice (the
acceptance-time tail lands in Phase 6+):

- **Non-atomic moves** (§14 bullet 1) — Appendix A.2 walkthrough:
  the cross-tree move arrives as two independent proposals routed to
  different reviewers with no shared decision dependency. The
  structural independence that makes partial landing possible is
  pinned here.
- **Cascade frontier expansion via nested creates** (the §11.3
  shape underlying §13's "cascade frontiers that expand across
  acceptances") — verified by the Appendix A.1 disposition test:
  *Paranormal Romance* is `latent` at submission and will become
  queueable only when *Urban Fantasy* is accepted (Phase 6).
- **Graft preserves ownership** (§9.3, A.2 narrative "Grafting does
  not transfer ownership") — verified in routing: a nested op under
  a graft routes to the **graft's existing owner**, not to the
  reviewer of the graft itself.

## Out of scope (deferred to later phases)

Unchanged from the initial plan: review actions (§12, §15.5) and
promotion (§11.3 acceptance side) → Phase 6; invalidation, dismissal,
`invalid–awaiting-dismiss` queue sub-state (§11.4, §12.4) → Phase 7;
ownership transfer on accepting a create (§9, §12.1) → Phase 6;
acceptance-time invariant validation against full containing tree(s)
(§10.3) → Phase 6; cross-process concurrency is not required.

## Changelog vs. `phase-5-initial.md`

The plans match on **scope and behavior** to test. Differences are
implementation-time refinements that emerged once code existed.

- **Added: `test/proposalsTestHelpers.ts` shared helpers (new
  convention).** Phases 1–4 duplicated their `freshApp` / `register` /
  per-endpoint helpers inside every test file. Phase 5's tests would
  have repeated significantly more boilerplate per file (registering
  multiple users, building multi-owner trees via Phase-4 writes,
  submitting proposals, reading queues from multiple perspectives), so
  this phase introduces a single `proposalsTestHelpers.ts` module that
  the proposal test files import from. The filename intentionally
  lacks `.test.` so the `node:test` glob skips it. **Reason:** keep
  proposal tests focused on what they're asserting; avoid copy-paste
  drift across ten files. The earlier-phase files are unchanged and
  still follow their own duplicate-per-file convention.

- **Added: `proposalsReset.test.ts` "post-reset is fully usable"
  smoke.** Initial plan listed three reset assertions (clears
  proposals, clears queues, restarts the change-id counter) plus the
  §4-exemption preservation. The final suite adds one more test that
  exercises a full submit-after-reset round-trip. **Reason:** the
  three targeted assertions confirm individual contracts, but a
  resubmit smoke is the most direct way to catch a regression where
  some seam (e.g., a counter not actually clearing) makes the
  subsystem partially broken after reset. The cost of the extra test
  is one terse assertion.

- **Added: `proposalsReset.test.ts` malformed-header §4-exemption
  case.** Initial plan called for "Reset is still §4-exempt (callable
  by null / unregistered / malformed-header callers)". The final
  suite splits this into two tests (null-caller and malformed-header)
  rather than collapsing them. **Reason:** they exercise different
  middleware paths — null goes through the no-`X-Username` branch,
  malformed goes through `parseUsername`'s explicit
  whitespace-reject. A single test would have masked a regression in
  the malformed path while still passing on the null path.

- **Added: byte-level proposal-id and change-id counter-restart
  assertion in `proposalsReset.test.ts`.** Initial plan only named
  the requirement ("the change-id counter restarts at c1"). The
  final test captures the **first-issued** proposal id and change
  id pre-reset, then asserts the **first-issued post-reset** ids are
  identical strings. **Reason:** asserts the counter restarted to
  the documented starting value (`p1` / `c1`) without hard-coding
  the value at the assertion site — survives any future change to
  the starting value as long as the restart is consistent.

- **Added: writeSerialization "POST /proposals" addendum uses three
  parallel submissions, not two.** Initial plan said "two POST
  /proposals calls dispatched in the same tick produce distinct,
  ordered proposal IDs and ordered change IDs." The final test uses
  three. **Reason:** two would satisfy the monotonic claim with N=1
  successor; three pins both adjacencies independently and catches a
  regression where the queue runs in non-strict order (e.g. one
  hand-off swaps but the next maintains adjacency).

- **Refined: parsing tests use parameterized loops to exercise
  per-variant rejection.** Initial plan listed each rejection case as
  a separate bullet. The final suite uses `for (const v of [...])`
  loops to generate one test per variant. **Reason:** each variant
  ends up as a distinct `node:test` test (better failure isolation
  than a single test asserting many cases) but with one
  copy-paste-free declaration. The 49 tests in
  `proposalsParse.test.ts` are largely the product of these loops;
  the initial plan's bulleted list reflects the same case count.

- **Refined: `proposalsRouting.test.ts` re-uses the §10.1 keystone
  setup twice with different ownership shapes.** Initial plan
  described "the §10.1 keystone (different ops on / under one taxon
  route differently)" as one test. The final suite has two: the
  primary case where the keystone routes everything to the same
  owner (Bob owns c2), and a variant where the renamed taxon's owner
  is a third party (Carol). **Reason:** the original keystone case
  happens to route both the rename and the nested add to the **same**
  reviewer — useful for confirming the rule fires correctly, but
  doesn't actually demonstrate the "different reviewers" outcome.
  The variant test makes that outcome distinct enough to observe.

- **Refined: a graft-preserves-ownership test (group 2) demonstrates
  the latent-but-known-reviewer case from the Appendix A.2 narrative
  without needing the queue to be non-empty for Erin.** Initial plan
  said "Confirms two different reviewers receive different changes
  from the same proposal." The final test pins Frank's queue
  populated and Erin's queue empty (because Erin's change is latent
  under the graft's decision dependency), reflecting the actual
  Phase-5 observable behavior. **Reason:** the initial plan's
  wording would have suggested both reviewers see something — but in
  Phase 5, only the graft itself is queued; the nested create stays
  latent until acceptance (Phase 6). The test correctly asserts the
  Phase-5 slice of the A.2 narrative.

No scenarios were removed.
