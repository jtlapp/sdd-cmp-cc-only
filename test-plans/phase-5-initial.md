# Phase 5 — Initial Test Plan (FROZEN)

This plan is written from the spec (`prd/prd.md` §8, §9 (§9.1–§9.4), §10
(§10.1–§10.3), §11.3, §11.5, §13, §14, §15.2 (`GET /proposals*`,
`GET /queue`), §15.4, §15.6 and `prd/phase-5-proposal-submission.md`)
**before implementation begins**. Once any implementation code lands, this
file is frozen and must not be edited. The phase's `phase-5-final.md`
supersedes it and records what was actually tested, with a changelog of
differences.

## Scope under test

Phase 5 introduces the proposal subsystem up to — but not including — any
review decision. Proposals are accepted, parsed into a payload tree, fanned
out into individually-routed changes, classified by dependency, and assigned
their **initial** disposition (`queued` vs. `latent`). The read surfaces
that expose this state (`GET /proposals`, `GET /proposals/{id}`,
`GET /queue`) are also new in this phase.

In scope:

- **Payload model (§9.1).** Parsing the proposal body
  `{ targetRootId, topTaxonId, payload }` and the recursive payload-taxon
  tree, with the four ops (`no-op`, `rename`, `add`, `detach`), their
  per-op required/ignored fields, and the leaf restriction on `detach`.
- **Top-taxon constraints (§9.2).** Top op must be `no-op` or `rename`;
  the top taxon's `id` must be currently present in the target tree
  (reachable from the target root).
- **Create vs. graft (§9.3).** `add` with `id: null` (create — `name`
  required) vs. `add` with an existing `id` (graft — `name` ignored).
  Both may carry nested ops.
- **Partial-payload rule (§9.1).** Untouched children of a live taxon
  need not be restated; the payload asserts nothing about them.
- **Change derivation + routing (§10.1).** Each operative payload taxon
  (rename, add, detach — **not** no-op) becomes exactly one change,
  routed to the single reviewer §10.1 specifies. `no-op` produces no
  change.
- **Dependency classification (§10.2).** For each change, ancestors on
  its payload path are classified as **decision** (add/graft) or
  **existence** (no-op/rename) dependencies. The top taxon itself is an
  existence dependency.
- **Validation scope per §10.3.** Recorded so later phases can validate
  against the full containing tree(s) regardless of how deep the
  anchor sits. Phase 5 does not perform acceptance-time validation —
  it only records the dependency structure that later phases will
  consume.
- **Initial disposition (§11.3).** At submission, a change is **queued**
  iff no `add`/graft ancestor sits on its payload path; otherwise it is
  **latent**. No promotion occurs in this phase.
- **New REST surfaces.**
  - `POST /proposals` (§15.4) — submit a proposal; proposer is taken from
    `X-Username` and must be a registered non-null user (Phase-2
    middleware).
  - `GET /proposals` (§15.2) — list proposals, optionally filterable by
    proposer.
  - `GET /proposals/{id}` (§15.2, the §11.5 isomorphic status view) —
    proposer's pulled-status view, structured isomorphic to the
    submitted payload, with a disposition per node.
  - `GET /queue` (§15.2) — calling user's currently queued changes
    across all proposals.
- **Authorization composition.** `POST /proposals` runs the Phase-2
  `identityWithRegistry` + `requireWriter` chain (null → 403,
  unregistered → 403, malformed `X-Username` → 400). The three reads
  use `identityWithRegistry` so null is allowed and only the registry
  check applies on a non-null caller (per §4 / §15.2).
- **State reset (§15).** `POST /reset` clears proposals, derived
  changes, reviewer queues, and any change-id counter, matching the
  per-phase obligation that every new in-memory state participates in
  reset.

Out of scope for Phase 5 (explicitly deferred by the brief and the PRD):

- **Review actions** (§12, §15.5): single accept, cascade accept, reject,
  dismiss — Phase 6+.
- **Promotion** of latent changes on dependency acceptance (§11.3) and
  ownership transfer on accepting a create (§9, §12.1) — Phase 6+.
- **Invalidation and dismissal** (§11.4, §12.4) and the
  `invalid–awaiting-dismiss` sub-state on `/queue` — Phase 7+. (Phase 5's
  queue contains only true queued changes.)
- **Acceptance-time invariant validation against the full containing
  tree(s)** (§10.3). The dependency structure that drives that check is
  recorded now; the check itself runs when acceptance is implemented.

## Resolved spec ambiguities (decided up front, recorded for traceability)

The PRD names the behavior but leaves a handful of REST-shape and
submission-time-validation questions open. Each is decided before tests are
written and is part of what this plan verifies. Where the decision was put
to the user during planning, the chosen option is recorded here.

1. **Body field is `topTaxonId`** (per §15.4 and the brief), **not**
   `topNodeId`. Appendix A.1's `topNodeId` is treated as a non-normative
   typo. (Settled during planning.)

2. **`payload.id` must equal `topTaxonId`.** Both name the same anchor
   taxon; a mismatch is ambiguous. Mismatch → `400 validation_error`.
   (Settled during planning.)

3. **Submission-time existence check.** Every `id` field on a payload
   node that names an existing taxon (rename, detach, no-op, graft) must
   reference a currently-existing taxon. This is the minimum to make
   §10.1 routing well-defined (routing needs an owner to exist).
   Submission rejects an unknown id with `404 not_found`. (Settled
   during planning.) The **deeper** existence-dependency check (the
   no-op/rename ancestor's id being at the right *position* in the
   target tree) is **acceptance-time** per §10.3 and is deferred to
   Phase 6+.

4. **Top-taxon existence.** §9.2 requires the top taxon to be currently
   reachable from `targetRootId`. If `topTaxonId` is a known taxon but
   not in the target tree → `409 conflict` (a violation of an explicit
   PRD precondition, mirroring how Phase 4 surfaces §6.3 precondition
   failures). If `topTaxonId` is **unknown** (no such taxon at all) →
   `404 not_found`, matching decision #3.

5. **`targetRootId` validation.** Must reference an existing taxon
   (`404 not_found` if missing) and that taxon must currently be a root
   (`409 conflict` if it has parents). This matches the Phase-3 read
   contract for `GET /trees/{rootId}` and keeps `targetRootId` honest.

6. **`POST /proposals` 201 response body.** §15.4 says "201 with the
   proposal ID and its initial status tree." The body is
   `{ id, proposer, targetRootId, topTaxonId, payload }` where
   `payload` is the §11.5 status tree — the same shape
   `GET /proposals/{id}` returns. Keeping the two identical means the
   client never has to make a second request to reconcile.

7. **Disposition values in the §11.5 status view.** Five real states
   plus one structural marker:
   - `"latent" | "queued" | "accepted" | "rejected" | "invalid"` for
     operative changes;
   - `"structural"` for `no-op` payload taxa, distinguishing them from
     the five real states (§11.5 calls only for "a disposition indicating
     they are structural and produce no change" without naming it).
   In Phase 5 only `"latent"`, `"queued"`, and `"structural"` ever
   appear; the other three are reachable only in Phase 6+. (Settled
   during planning.)

8. **Status-view node shape.** Each operative node carries
   `{ op, id, name?, children?, changeId, disposition, reason? }`;
   each `no-op` node carries `{ op: "no-op", id, children?, disposition:
   "structural" }`. `reason` is omitted in positive states and in
   Phase 5 (no rejection/invalidation can yet occur). `changeId` is
   omitted on `no-op` (no change exists).

9. **Change IDs are server-assigned, monotonic, and reset-aware.** ID
   format `c1, c2, …` chosen to mirror taxon `t1, t2, …`. `POST /reset`
   restarts the counter to `c1`. Tests must not assume specific values
   — they capture them from the response.

10. **`GET /proposals` list shape.** `{ proposals: [<summary>...] }`
    where each summary is `{ id, proposer, targetRootId, topTaxonId }`,
    in submission order. The `?proposer=<username>` filter compares
    case-insensitively via the registry's canonical form; an unknown
    filter value returns `{ proposals: [] }` (200, not 404 — a filter is
    a query convenience, not a resource lookup).

11. **`GET /queue` entry shape.** `{ changes: [<entry>...] }`. Per §15.2
    "Each entry exposes at least: change ID, proposal ID, operation,
    the affected taxon(s)/edge, and the target root." Shape:
    `{ changeId, proposalId, op, targetRootId, taxonId?, name?,
       payloadParentTaxonId?, state }`. `taxonId` is the renamed taxon
    (rename), the grafted taxon (add-graft), or absent (add-create).
    `name` is the proposed new name (rename, add-create). `state` is
    `"queued"` in Phase 5; the §15.2 "including invalid-awaiting-dismiss"
    sub-state is unreachable here and lands in Phase 7. Queue order is
    change-id (i.e., submission) order across all proposals.

12. **Self-routed proposals are allowed.** Nothing in §8–§12 forbids a
    proposer from submitting a proposal whose changes route to herself
    (she's the owner of the renamed/parent taxon). The change queues to
    her like any other; in Phase 6 she'll be able to accept it. (Phase 5
    only pins the routing/queueing behavior.) (Settled during planning.)

13. **Validation precedence is fixed**, mirroring Phase-4 decision #5:
    1. Identity (Phase-2 middleware): malformed `X-Username` → 400,
       unregistered → 403, null → 403 (`requireWriter`).
    2. Body parsing: non-JSON / non-object body → 400; missing/wrong-
       type top-level keys (`targetRootId`, `topTaxonId`, `payload`)
       → 400.
    3. Resource lookup against the global graph: any id named in the
       proposal body or the payload tree that does not exist → 404
       (decision #3).
    4. Body field validation: per-op required-field violations, leaf
       rule for `detach`, name-format violations, top-op-must-be-no-op-
       or-rename → 400.
    5. Domain preconditions: `targetRootId` is not a root → 409;
       `topTaxonId` exists but is not in the target tree → 409.
    6. (No invariant validation against post-state in this phase —
       deferred to acceptance per §10.3.)

14. **Unknown keys in proposal/payload nodes are ignored**, mirroring
    Phase-4 decision #6 (PATCH lenience). Only `op`, `id`, `name`, and
    `children` are consumed on a payload node; only `targetRootId`,
    `topTaxonId`, and `payload` on the proposal body.

15. **Reset of proposals is observable** and aligns with §15: after
    `/reset`, `GET /proposals` returns an empty list, `GET /queue`
    returns an empty list for every (subsequently-registered) caller,
    and the change-id counter restarts at `c1` (decision #9). The
    taxon-id counter restart from Phase 4 is unaffected; both restart
    on the same reset.

## Coverage dimensions (per the brief)

The brief enumerates three coverage dimensions for this phase. Each maps
to the test groups below:

- **New behavior** — payload parsing and validation, per-op routing,
  dependency classification, and initial latent/queued disposition,
  including boundary conditions where a rule's outcome changes (e.g.
  the §10.1 keystone where a rename and its nested add route to
  *different* owners; the §11.3 boundary where a rename-ancestor does
  **not** make a descendant latent but an add-ancestor does). Groups 1–5
  cover this.
- **Interactions with earlier phases** — proposals are submitted against
  the multi-owner, multi-tree state Phases 1–4 produce, routed by the
  ownership established there, and gated by the Phase-2 proposer
  middleware. Groups 1, 4, 5, 7, and 9 cover this directly; groups 2–3
  build the necessary multi-owner shapes.
- **Failure and invalid states** — the specified behavior for malformed
  payloads and for top-taxon / payload constraints that don't hold.
  Group 1 carries the bulk of this; groups 2–5 each have a failure
  sub-section for the constraints visible at their level. Per the
  Phase-4 convention, each error-path test asserts both the §15.6 code
  and the envelope shape.

### §14 accepted properties verified in this phase

The brief instructs us to treat §14 as intended behavior to verify.
Phase 5 directly exercises:

- **Non-atomic moves** (§14 bullet 1). The two-proposal move from
  Appendix A.2 (detach in T1 + graft under T2) is submitted in two
  separate proposals; the change set produced demonstrates that the
  two halves are independent units of decision (different reviewers,
  different proposals, no shared decision dependency between them).
  Phase 5 stops short of acceptance, so the "lands partially" outcome
  itself is Phase-6+ — but the **structural independence** that makes
  partial landing possible is asserted here.
- **Cascade frontier expansion across acceptances** (§13 edge-case
  list, surfaced via §10.2). Appendix A.1's *Paranormal Romance*
  shape — a create nested under a create — is asserted here: it
  starts `latent` (decision-dep on the outer create) and will only
  become `queued` when the outer is accepted (Phase 6+).
- **Grafted subtree brings its live subtree implicitly** (§9.3) — the
  routing of nested ops under a graft is tested for the Appendix A.2
  case where the nested op routes to a **different** owner than the
  graft itself (Erin owns the grafted `a3`; Frank reviews the graft
  itself).

## Test groups

Files mirror the modules they exercise, matching the Phases 1–4
convention. Concrete file names are nominal; the implementation may
split or merge as long as the listed scenarios are covered.

### 1. Payload parsing & body validation — `proposalsParse.test.ts`

Pure body-level concerns: the proposal envelope, per-op schema, top-taxon
constraints. Each invalid-body case asserts both the HTTP status and the
§15.6 envelope's `code`.

Body envelope:

- Valid minimal body (top is a `no-op` over a known root, no children)
  → `201`. Smoke that the round-trip works at all.
- Invalid JSON → `400 validation_error`.
- Body is not a JSON object (array, string, number, null) → `400`.
- Body missing `targetRootId` / `topTaxonId` / `payload` (each in
  isolation) → `400`.
- `targetRootId` is not a string → `400`.
- `topTaxonId` is not a string → `400`.
- `payload` is not a JSON object (array, string, null) → `400`.
- Unknown top-level keys (`{ ..., extra: 1 }`) are ignored (decision #14)
  → `201`.

Per-op schema (decision #14 lenience applies to extra payload-node keys):

- Each op accepted with its required fields, no children: `no-op`,
  `rename`, `add`-create, `add`-graft, `detach` (the last as a nested op
  beneath a top no-op, since it can't be the top).
- `op` missing or unknown ("foo", null, 1) → `400`.
- `no-op` without `id` → `400`. `no-op` with non-string `id` → `400`.
- `rename` without `id` → `400`. `rename` without `name` → `400`.
  `rename` with name-format violation (empty / leading or trailing
  whitespace) → `400` (re-uses Phase-1 validator).
- `add` with neither `id` nor explicit `id: null` → `400` (the field is
  required; a missing key is not "null"). `add` with `id: null` and no
  `name` → `400`. `add` with `id: null` and bad-format `name` → `400`.
  `add` with non-null non-string `id` → `400`.
- `detach` with children → `400` (leaf rule, §9.1).
- `detach` without `id` → `400`.
- Children field that is not an array → `400`. Children with a non-object
  element → `400`.
- Unknown extra keys on a payload node alongside valid required fields
  → `201` (decision #14).

Top-taxon constraints (§9.2):

- Top op is `add` → `400` (top must be `no-op` or `rename`).
- Top op is `detach` → `400`.
- `payload.id` mismatches `topTaxonId` → `400` (decision #2).
- `topTaxonId` (and matching `payload.id`) names an unknown taxon →
  `404 not_found` (decision #3 + #4 unknown branch).
- `topTaxonId` exists but is not reachable from `targetRootId` (e.g.
  taxon is in another tree, or in no tree at all because it has no
  parent and isn't the named root) → `409 conflict`.

`targetRootId` validation (decision #5):

- Unknown id → `404 not_found`.
- Known id that is not a root (has parents) → `409 conflict`.

Submission-time existence (decision #3):

- A nested `rename` with `id` referring to an unknown taxon → `404`.
- A nested `detach` with unknown `id` → `404`.
- A nested `add`-graft with unknown `id` → `404`.
- A nested `no-op` with unknown `id` → `404`.

Authorization (mirrors Phase 4):

- Null user (no `X-Username`) → `403 forbidden`.
- Unregistered well-formed `X-Username` → `403`.
- Malformed (NBSP-prefixed) `X-Username` → `400 validation_error`.

### 2. Routing per §10.1 — `proposalsRouting.test.ts`

Pure per-op routing assertions. Built against multi-owner multi-tree
state produced by Phase-4 writes, then a `POST /proposals` is dispatched
and the resulting changes' reviewer + queue placement is read back via
`GET /queue` from the perspective of each candidate reviewer.

Per-op routing:

- `rename` → owner of the renamed taxon (`id`). Setup: A owns parent,
  B owns the renamed child. Rename routes to **B**, not A.
- `detach` → owner of the **payload-parent** (the parent under which
  the detach appears in the payload). Setup: A owns the parent, B owns
  the child. The detach is on B's child but routes to **A** (the
  parent's owner, who holds the "remove child edges" right).
- `add`-create → owner of the payload-parent.
- `add`-graft → owner of the payload-parent (not the owner of the
  grafted taxon).
- `no-op` → produces no change, no entry in any reviewer's queue.

The §10.1 keystone (different ops on / under one taxon route differently):

- Setup: A owns `r1`, B owns child `c2` under `r1`. Payload anchored at
  `r1`: `rename c2` + nested under `c2` an `add`-create. The `rename`
  routes to **B** (c2's owner). The nested add routes to **B** (c2 is
  the add's payload-parent and B owns it). A change visible to B but
  not to A — `/queue` reads from both accounts.
- Variant: under a no-op anchor at `r1`, a `rename r2` (r2 owned by C)
  + nested `add`-create. The rename routes to **C**. The nested add
  routes to **C** (r2 owns the payload-parent position).

Graft preserves ownership in routing (§9.3, Appendix A.2):

- Setup: Frank owns root `b1` → `b2` (Frank); separate tree T1 has `a3`
  owned by Erin. Proposal anchored at `b1`: `add`-graft `a3` under
  `b2`, with nested `add`-create under the graft. The graft routes to
  **Frank** (owner of `b2`). The nested create routes to **Erin**
  (owner of the grafted `a3`, which is the payload-parent — graft
  doesn't transfer ownership). Confirms two different reviewers
  receive different changes from the same proposal.

Cross-tree side effect of routing:

- The proposer is **not** automatically a reviewer of any of her own
  proposal's changes — unless she happens to own a targeted/parent
  taxon. A proposal anchored entirely in trees the proposer doesn't
  own produces an **empty** `GET /queue` for the proposer.

### 3. Dependency classification — `proposalsDependencies.test.ts`

Tests against `GET /proposals/{id}` (status view, with dispositions) and
`GET /queue` to verify the §10.2 classification of payload-path
ancestors. The status view alone shows latent vs. queued; that gives us
an observable signal for "which ancestors are decision deps."

Decision dependency = `add`/graft ancestor:

- A nested `add` under an `add`-create (Appendix A.1's *Paranormal
  Romance* shape) → the inner add is **latent**. Status view confirms.
- A nested `add` under an `add`-graft → **latent**. Confirms graft
  also counts as a decision dependency.
- A nested `rename` under an `add`-create → **latent** (because the
  add is on the path, even though the rename targets a different
  taxon that already exists). Confirms the dependency is about
  *ancestors on the path*, not about the rename's own taxon.
- A nested `detach` under an `add`-graft → **latent**. Confirms detach
  also gates on the decision-dep ancestor.

Existence dependency = `no-op` / `rename` ancestor:

- A nested `add` under a top **`rename`** (no `add` ancestor on the
  path) → **queued** at submission. This is the §11.3 keystone — a
  pending rename does not block a descendant.
- A nested `rename` under another `rename` (sibling renames stacked
  in a single `no-op` parent — each rename's path includes only its
  own ancestor renames and the no-op top) → both **queued**.
- A nested `detach` under a `no-op` anchor → **queued**.

Top taxon as existence dependency:

- The top taxon's existence is the existence dependency for every
  change in the proposal; this is observable indirectly through the
  status view's structure (no change is created for the top no-op,
  but every nested change's path includes it).

Mixed path (Appendix A.1 full shape):

- Submit Appendix A.1's exact proposal. Confirm dispositions:
  - `rename c1` → queued.
  - `rename c3` → queued (rename ancestor only).
  - `add Urban Fantasy` (create under `c2`) → queued (no add
    ancestor — the path is rename(c1)/no-op(c2)/this).
  - `add Paranormal Romance` (create under Urban Fantasy) → latent
    (add ancestor present).
- This single test pins the entire §11.3 / §10.2 contract by example.

### 4. Initial disposition — `proposalsDisposition.test.ts`

Sharper, more targeted assertions on `queued` vs. `latent`, complementary
to group 3 (which is structured around the dependency classification).
Here the focus is *boundary cases where the disposition flips*.

- Path with exactly one decision-dep ancestor → latent.
- Path with two decision-dep ancestors → latent (same outcome — the rule
  is "any add ancestor"; this confirms we don't accidentally count or
  thresh).
- Path with zero decision-dep ancestors but many existence-dep ancestors
  (a deep `no-op`/`rename` chain ending in a `rename` or `detach`) →
  queued.
- Sibling changes under the same parent where one sibling is `add` and
  another is `rename` — both **queued** because neither sits *under*
  the other (decision-dep on a sibling does not gate you).
- A `no-op` payload taxon itself is structural, not in any queue, and
  carries no change-id. Status-view assertion.

Queue placement matches disposition:

- Every queued change has exactly one entry in its reviewer's `/queue`.
- Every latent change has **zero** entries in any reviewer's `/queue`.
  (Built by enumerating reviewers across all users registered in the
  test.)

### 5. Partial-payload rule — `proposalsPartialPayload.test.ts`

§9.1: a payload taxon asserts something about itself and the children
explicitly listed beneath it, and **nothing** about any unlisted children
of the corresponding live taxon.

- Live state: `r1` owns children `c1`, `c2`, `c3`. Payload anchored at
  `r1` mentions only `c2` (via a nested `no-op` over `c2`). Submitting
  succeeds; the resulting changes mention only payload-listed taxa;
  `c1` and `c3` are not present in the status view; no change is
  produced about them.
- Variant: payload anchored at `r1` lists `c2` with a single nested
  `detach` of `c2`'s child `c2a`. The detach is the only change
  produced; `c2`'s other children are not asserted about and are
  untouched in the change set.
- Negative: a payload that explicitly lists `c2` then under it adds a
  `no-op` for a *non-existent* child id (e.g., a sibling that doesn't
  exist) → `404` per decision #3. Distinguishes "not asserting about
  unlisted children" (allowed, no-op partial) from "asserting about a
  child that doesn't exist" (rejected).

### 6. Status view (`GET /proposals/{id}`) — `proposalsStatusView.test.ts`

The §11.5 isomorphic, pulled-status view. Tests pin structure rather
than prose.

Isomorphism:

- The status view's node count, ordering, and parent/child relationships
  match the submitted payload exactly. Verified on a non-trivial
  payload (Appendix A.1's shape).
- Every operative payload node maps to one operative status node with a
  `changeId` and a `disposition`. Every `no-op` payload node maps to one
  status node with `disposition: "structural"` and **no** `changeId`
  (decision #8).
- The `op`, `id`, and `name` fields on each status node match the
  submitted values (modulo decision #14 — unknown payload keys are
  dropped, not echoed).

Disposition rendering:

- Every operative change has one of the five real disposition strings
  (decision #7); in Phase 5 only `"latent"` and `"queued"` appear.
- A `no-op` node carries `"structural"` exactly.
- The `reason` field is absent in Phase 5 (no rejection/invalidation
  paths exercised); the test confirms it's *not* sent when there is no
  reason rather than being sent as `null` or `""`.

Access control:

- `GET /proposals/{id}` is readable by **anyone**, including the null
  user (per §15.2 "readable by anyone; this is also how a reviewer
  obtains the proposed change payload").
- Unknown proposal id → `404 not_found`.
- Malformed `X-Username` → `400` (the identity gate still runs).

Round-trip with the 201 response (decision #6):

- The `payload` returned by `POST /proposals` is byte-equal to the
  `payload` returned by an immediately-following `GET /proposals/{id}`.

### 7. List proposals (`GET /proposals`) — `proposalsList.test.ts`

The §15.2 list endpoint with the optional proposer filter.

- Empty server → `{ proposals: [] }`.
- One proposal submitted → list contains one summary with the expected
  `id`, `proposer`, `targetRootId`, `topTaxonId`.
- Multiple proposals from different proposers → list contains all in
  submission order (decision #10).
- `?proposer=<alice-canonical>` → returns only Alice's proposals.
- `?proposer=ALICE` (case-variant) → same set as canonical (decision
  #10 case-insensitive via registry canonical form).
- `?proposer=<unregistered>` → `{ proposals: [] }` (200, not 404 —
  decision #10).
- Null caller may read this list (§15.2 — reads are open to null).
- Malformed `X-Username` → `400`.

### 8. Caller queue (`GET /queue`) — `queueRead.test.ts`

The §15.2 per-caller queue read.

- An unregistered or null caller's queue: §15.2 says queue lists "the
  calling user's" changes. Because all queued changes route to a
  *registered* owner, and identity gating sends the null user through
  with kind=null and rejects the unregistered case at 403, the
  behavior is:
  - Null caller → empty list (`{ changes: [] }`, 200). The null user
    can read the queue, but nothing is ever routed to them.
  - Unregistered caller → `403 forbidden`.
  - Malformed `X-Username` → `400`.
- Registered caller with no incoming changes → `{ changes: [] }`.
- After a proposal submission that produces one queued rename routed
  to caller → one entry with the documented shape (decision #11),
  carrying `changeId`, `proposalId`, `op: "rename"`, `taxonId`,
  `name`, `targetRootId`, `state: "queued"`.
- After a submission that produces multiple queued changes routed to
  different reviewers (the §10.1 keystone setup) → each reviewer's
  queue contains exactly her own changes; no cross-talk.
- Latent changes are never in any queue (cross-reference with
  group 4).
- Per-op entry shape (decision #11):
  - `rename` entry has `taxonId` + `name`, no `payloadParentTaxonId`.
  - `add`-create entry has `payloadParentTaxonId` + `name`, no
    `taxonId`.
  - `add`-graft entry has `payloadParentTaxonId` + `taxonId`, no
    `name`.
  - `detach` entry has `taxonId` + `payloadParentTaxonId`, no `name`.
- Queue ordering: across multiple submissions, entries are returned
  in change-id (submission) order (decision #11).

### 9. Cross-phase integration — `proposalsIntegration.test.ts`

End-to-end stories tying multiple operations from earlier phases plus
a proposal submission, to verify the phase composes correctly.

- **Appendix A.1 walkthrough up to submission.** Build the live state
  via Phase-4 writes (`POST /taxa` + `PUT .../children/...` to assemble
  the Alice/Bob multi-owner tree). Carol (proposer, separately
  registered) submits the A.1 proposal. Verify, via three queue reads
  (Alice, Bob, Carol):
  - Alice sees the `c1` rename.
  - Bob sees the `c3` rename **and** the *Urban Fantasy* create.
  - Carol sees nothing.
  - The *Paranormal Romance* create is in nobody's queue (latent), but
    appears in `GET /proposals/{id}` with `disposition: "latent"`.
- **Appendix A.2 two-proposal cross-tree move (submission only).**
  Build T1 (Dana-owned `a1 → a2`, Erin-owned `a3` beneath) and T2
  (Frank-owned `b1 → b2`). Grace (proposer) submits P1 (detach `a3`
  from `a2`) and P2 (graft `a3` under `b2` with a nested create).
  Verify:
  - Dana's queue contains P1's detach.
  - Frank's queue contains P2's graft.
  - Erin's queue is empty (the nested create is latent on the graft
    decision).
  - Both proposals appear in `GET /proposals`; neither references the
    other (independence, §14 bullet 1).
- **Self-routed proposal.** Alice (registered) creates a tree she
  owns entirely, then submits a proposal of her own renaming her own
  taxon. The change routes to Alice; her queue contains it. (Phase 6
  will let her accept it.)
- **Reset across the lifecycle.** Submit one proposal, verify it
  appears via the three reads, `POST /reset`, then re-bootstrap and
  submit a fresh proposal. The fresh proposal's `id` is `p1` again
  (counter restart, decision #15) and the fresh change ids are `c1`,
  `c2`, … (decision #9). No residue is observable from the
  pre-reset state.

### 10. Reset clears proposal state — folded into `app.test.ts` / `proposalsReset.test.ts`

Targeted verification of the §15 reset contract for the new state this
phase introduces (decision #15).

- `POST /reset` clears the proposals registry: `GET /proposals` → `{
  proposals: [] }` after a non-empty pre-reset state.
- `/reset` clears every reviewer's queue: previously-queued reviewers
  see `{ changes: [] }`.
- `/reset` restarts the change-id counter: the next submitted change
  is `c1`.
- Reset is still §4-exempt (callable by null / unregistered /
  malformed-header callers) — assertions from the Phase-4 reset
  suite are re-checked to confirm Phase 5's reset additions don't
  regress the gate. Two of the three preconditions above are
  exercised via a null-user `/reset` to keep the exemption alive.

### 11. Write serialization — covered by `writeSerialization.test.ts`

Phase 5 only re-uses the §11.1 lock for `POST /proposals`. Phase 4's
serializer tests still pass; one new assertion is added to that suite:

- Two `POST /proposals` calls dispatched in the same tick produce
  distinct, ordered proposal IDs and ordered change IDs (queue order
  matches submission order, decision #11). This confirms the lock
  catches the new write path the same way it caught Phase-4's writes.

### 12. §15.6 envelope round-trips — folded into the per-op suites

Each error-path test that this plan calls out also asserts:

- HTTP status matches the §15.6 mapping (400 / 403 / 404 / 409).
- Response body is the envelope `{ error: { code, message, details? } }`
  with the expected `code`.
- Where 409 is used (decisions #4 and #5), the message or `details`
  names the offending id so a client can surface a useful error.
  Tests don't pin the exact prose but do assert that the relevant ID
  appears.

This mirrors how Phases 2–4 distributed envelope-shape assertions
across the endpoint suites.

## Out of scope (deferred to later phases)

- Review actions (`POST /changes/{id}/accept`, accept-cascade, reject,
  dismiss) → Phase 6 (and Phase 7 for dismiss).
- Promotion of latent → queued on dependency acceptance (§11.3) →
  Phase 6.
- The `invalid–awaiting-dismiss` queue sub-state, self-invalidation
  auto-dismissal, external invalidation (§11.4) → Phase 7.
- Ownership transfer on accepting a create (§9, §12.1) → Phase 6.
- Acceptance-time invariant validation against full containing
  tree(s) (§10.3) — the dependency structure that drives this check is
  recorded in Phase 5; the validation itself runs in Phase 6.
- Re-validation of latent changes' existence dependencies when their
  ancestor add is accepted (§11.3 "provided their existence
  dependencies also currently hold") → Phase 6.
- Atomic cascade acceptance (§12.2) and its rollback semantics →
  Phase 6.
- Reason field (§11.5 "for negative states") populated content →
  Phase 6+ when rejection/invalidation can produce one.

## Notes on test mechanics (per the toolchain supplement)

- Tests use `node:test` and `node:assert/strict`; no third-party
  framework or assertion helper.
- Tests live under `test/`, are named `*.test.ts`, are compiled by
  `tsc`, and run via `node --test "dist/**/*.test.js"`.
- HTTP-level tests use `app.request(...)` against an in-process Hono
  app (no port binding).
- Per-test isolation: `POST /reset` runs before each test that touches
  server state; users are then explicitly registered as the test needs.
  No test depends on a specific server-assigned ID — IDs (taxa,
  proposals, changes) are captured from response bodies and referred
  to by variable.
- Malformed-`X-Username` cases use NBSP (U+00A0) for the leading
  whitespace character, per the Phase-2 / Phase-4 final-plan note on
  HTTP OWS stripping (Hono's `Request` constructor strips ASCII OWS).
- Names in tests draw from `prd/sample-taxonomy.md` (non-normative)
  where convenient — "Fiction", "Fantasy", "Epic Fantasy", "Urban
  Fantasy", "Paranormal Romance", "Psychological Thriller", etc. —
  and fabricate fresh names where the sample doesn't cover a needed
  shape. The Appendix A.1 / A.2 fixtures intentionally re-use the
  appendix names so the worked examples are testable verbatim
  (modulo the field-name decision #1).
- Where a test needs a pre-existing graph that Phase-4 writes can build
  themselves, it builds via those writes (`POST /taxa` +
  `PUT /taxa/.../children/...`). Phase-3 fixture primitives are
  reserved for shapes Phase-4 writes can't construct (none expected
  for Phase 5 — every fixture this plan calls for is buildable
  through the public HTTP surface).
