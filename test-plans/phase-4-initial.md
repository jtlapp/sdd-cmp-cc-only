# Phase 4 — Initial Test Plan (FROZEN)

This plan is written from the spec (`prd/prd.md` §5, §6 (§6.1–§6.4), §7, §11.1,
§13, §14, §15.3, §15.6 and `prd/phase-4-direct-actions.md`) **before
implementation begins**. Once any implementation code lands, this file is
frozen and must not be edited. The phase's `phase-4-final.md` supersedes it and
records what was actually tested, with a changelog of differences.

## Scope under test

Phase 4 introduces the owner-authoritative, non-proposal mutation surface, the
global write serialization that gates it, and the validating mutation layer
that funnels every write through the Phase-3 invariant module.

In scope:

- **Write serialization (§11.1).** A single global serializer through which
  every state-mutating handler runs; reads remain un-synchronized. `POST
  /reset` also runs under the same serializer (§15).
- **Create (§6.1).** `POST /taxa` — body `{ name }` — caller becomes owner;
  taxon is created as a root with no children.
- **Edit (§6.2).** `PATCH /taxa/{id}` — body `{ name?, owner? }` — owner-only;
  name validated across **every** containing tree via the Phase-3 invariant
  module; owner-reassignment to any registered, non-null username (unilateral,
  no consent solicited).
- **Edge add/remove (§6.4).** `PUT /taxa/{parentId}/children/{childId}` and
  `DELETE /taxa/{parentId}/children/{childId}` — parent-owner only. Addition
  validated against all §3.3 invariants in the affected tree(s) via the
  invariant module; removal is **detach-only** (§7).
- **Delete (§6.3, §7).** `DELETE /taxa/{id}` — owner only — the deletion
  region (N + descendants reachable through wholly-U-owned paths), halt-and-
  detach at other-owned taxa, the two §6.3 preconditions, and the §14
  consequence that U-owned descendants beneath an other-owned halt point are
  **not** deleted.

Authorization composes the Phase-2 middleware (`identityWithRegistry` +
`requireWriter` for any write — null user → 403, unregistered → 403,
malformed → 400). Existing §15.2 reads are unchanged by this phase but are
exercised here to verify post-write state.

Out of scope for Phase 4 (deferred): proposals (§8–§12), the queue (§15.4),
review actions (§15.5). Delete is **never** proposable (§7).

## Resolved spec ambiguities (decided up front, recorded for traceability)

The PRD names the operations but leaves a handful of REST-shape and
input-handling questions open. Each is decided before tests are written and
is part of what this plan verifies. Where the decision was put to the user
during planning, the chosen option is recorded here.

1. **`PATCH /taxa/{id}` with an empty body (`{}` — no `name`, no `owner`) →
   `400 validation_error`.** A PATCH must request at least one field change;
   "succeeded but did nothing" would be an ambiguous outcome. (Settled during
   planning, recommended option.)

2. **`PUT /taxa/{parentId}/children/{childId}` when the edge already exists
   → `204` idempotent no-op.** PUT in REST is idempotent; the post-state is
   identical regardless of pre-state. Invariants are already satisfied, so
   no extra check is needed on the no-op branch — though the implementation
   still routes through the same path for uniformity. (Settled during
   planning.)

3. **`DELETE /taxa/{parentId}/children/{childId}` when both taxa exist but
   no edge connects them → `404 not_found`.** §6.4 phrases removal as
   "Remove (detach) an existing child edge from the parent" — the edge
   resource must exist. Distinguishes "edge was never there" from "edge was
   just removed", which a silent idempotent 204 would conflate. (Settled
   during planning.)

4. **`DELETE /taxa/{id}` on success → `204 No Content`.** REST-conventional;
   the spec does not require a body, and tests can verify post-state via
   the §15.2 reads. The §14 consequences (which taxa were deleted, which
   were detached at the halt frontier) are observable through `GET /taxa`
   and `GET /trees` after the call. (Settled during planning.)

5. **Validation precedence is fixed.** For every write, the layered checks
   run in this order and the first failure short-circuits with its
   characteristic §15.6 code:
   1. Identity (Phase-2 middleware): malformed `X-Username` → 400,
      unregistered → 403, null → 403 (`requireWriter`).
   2. Body parsing: non-JSON / non-object body → 400.
   3. Resource lookup: any URL-named taxon that does not exist → 404.
   4. Authorization: caller is not the relevant owner (taxon-owner for
      edit/delete, parent-owner for edge ops) → 403.
   5. Body field validation: malformed name, wrong field type, owner not
      a registered non-null username → 400.
   6. Domain invariants / preconditions: §3.3 invariant violations (cycle,
      in-tree duplicate, in-tree name clash) and §6.3 delete preconditions
      → 409 with a reason naming the offender.

   The order matters because 403/404/400/409 each communicates a different
   class of failure and the §15.6 mapping shouldn't depend on what the
   implementation happens to check first.

6. **Unknown keys in PATCH bodies are ignored**, not rejected. Only `name`
   and `owner` are consumed. The strict rejection is reserved for the
   "nothing-to-change" case (decision #1). This matches typical REST
   leniency and keeps the contract small.

7. **Response shapes mirror Phase-3 reads.**
   - `POST /taxa` → `201` with the same `{ id, name, owner, childIds: [],
     parentIds: [] }` record shape `GET /taxa/{id}` returns. A freshly
     created taxon has empty `childIds` and empty `parentIds` (§6.1: starts
     as a root with no children).
   - `PATCH /taxa/{id}` → `200` with the **updated** taxon record in the
     same shape.
   - All edge ops and `DELETE /taxa/{id}` → `204 No Content` (decisions
     #2, #4 above).

8. **Setting `owner` on `PATCH` to the current owner is a valid no-op**, not
   an error. §6.2 doesn't require the new owner to differ; the only rule is
   that it be a registered, non-null username. The taxon is returned with
   its existing owner unchanged.

9. **`PATCH` body field validation distinguishes 400 from 409.** A
   structurally invalid input (`name` is not a string, `name` violates §3.4
   format, `owner` is not a string, `owner` is null, `owner` is not a
   registered username) → 400 `validation_error`. A *structurally valid*
   change that breaks a §3.3 invariant in some containing tree (name clash
   anywhere the taxon appears) → 409 `conflict`. The unregistered-`owner`
   case is treated as a request-content validation failure (`400`), distinct
   from the unregistered-*caller* case (`403`) that the Phase-2 middleware
   already covers.

10. **Cascade delete is atomic under the write lock.** §11.1's serialization
    means the entire region removal + halt-frontier detachment happens
    inside one critical section; no read can observe a partially-deleted
    region. (Reads aren't lock-synchronized, but JavaScript's single-threaded
    event loop guarantees a read can't interleave with a mutation that
    doesn't `await`. The mutation handlers don't `await` between
    region-walk and apply.)

11. **`POST /reset` runs under the same write lock.** §15 says reset "runs
    under the §11.1 write serialization"; Phase 3 implemented reset before
    a lock existed, so Phase 4 retrofits it. The §4 exemption (callable by
    null / unregistered / malformed-header callers) is preserved.

## Coverage dimensions (per the brief)

- **New behavior** — success, error, and conflict paths for create, edit,
  edge add/remove, and delete, including boundary conditions where a rule's
  outcome changes. The deletion-region computation and its two
  preconditions are the subtlest part and get boundary attention.
- **Interactions with earlier phases** — every write goes through the
  Phase-2 authorization gate (null / unregistered / malformed) and the
  Phase-3 invariant module. Tests exercise these operations against
  multi-owner, multi-tree state rather than in isolation. Cross-tree
  name-clash detection (the Phase-3 invariant-module's keystone case) is
  re-exercised at the HTTP boundary via a real `PATCH /taxa/{id}` rename.
- **Failure and invalid states** — the specified behavior when an operation
  is forbidden or would violate an invariant or precondition, not merely
  that it fails. The §15.6 envelope's `code`, `message`, and `details` are
  checked where relevant.
- **§14 accepted properties** — verified as intended behavior:
  - **Ownership reassignment is unilateral** (§14 bullet 3): a PATCH that
    reassigns a taxon to a registered user succeeds without consulting the
    recipient; the recipient may immediately exercise owner rights on the
    taxon.
  - **Cascade deletion never removes other users' taxa** (§14 bullet 4):
    the halt-frontier branch is tested for both the detachment side
    (other-owned child survives, edge gone) and the strand side (U-owned
    taxa below an other-owned halt point are **not** deleted).
  - **Deletion may require collaboration** (§14 bullet 2): a delete that
    *would* succeed structurally fails as a 409 because a U-owned taxon in
    the region is shared into another tree, demonstrating the precondition-1
    barrier. (The full "use a proposal to fix it" path is Phase 5+.)
  - **Name uniqueness is enforced per-tree but names are global** (§14
    bullet 5): a PATCH-rename valid in the renamed taxon's "own" tree but
    invalid in another containing tree → 409.

## Test groups

Files mirror the modules they exercise, matching the Phase-1–3 convention.
Concrete file names are nominal; the implementation may split or merge as
long as the listed scenarios are covered.

### 1. Write serializer — `writeLock.test.ts`

Unit tests of the serializer primitive in isolation (no HTTP).

- Two writes started in parallel run sequentially — the second observes
  the first's effects rather than racing it.
- A write that throws does **not** stall subsequent writes: the queue
  continues past the rejected promise.
- An `await`-suspended write holds the lock until it resolves; writes
  queued behind it observe its committed state.
- Reads bypass the serializer (no API — but it's tested implicitly by the
  rest of the suite running without read-side awaits).

### 2. Create — `taxaCreate.test.ts`

`POST /taxa` end-to-end through `createApp`.

Happy paths:

- Registered caller, valid name → `201` with the new taxon record:
  caller is owner, `childIds: []`, `parentIds: []`, monotonic ID issued by
  the store.
- Two consecutive creates return distinct, monotonically-ordered IDs.
- A freshly-created taxon appears in `GET /taxa`, in `GET /trees` (as a
  root), and `GET /trees/{id}` returns `{ id, name, owner, children: [] }`.

Authorization:

- Null user (no `X-Username`) → `403 forbidden`.
- Unregistered well-formed `X-Username` → `403 forbidden`.
- Malformed (NBSP-prefixed) `X-Username` → `400 validation_error`.

Body validation:

- Missing body (no JSON) → `400 validation_error`.
- Non-object body (array, string, number, null) → `400`.
- Body without `name` → `400`.
- `name` not a string → `400`.
- `name` empty → `400`.
- `name` with leading whitespace → `400`.
- `name` with trailing whitespace → `400`.
- Unknown extra keys (`{ name, owner: "x" }`, `{ name, foo: 1 }`) — `owner`
  in the body is **ignored** on create (per §6.1 the creator is always the
  owner); the create succeeds and the caller becomes the owner. Unknown
  keys are also ignored.

State integration:

- Two registered users (Alice, Bob) each create a taxon → each owns their
  own; `GET /taxa` lists both in creation order.

### 3. Edit — `taxaEdit.test.ts`

`PATCH /taxa/{id}` end-to-end through `createApp`.

Happy paths:

- Owner changes name → `200` with updated record; `GET /taxa/{id}`
  reflects it.
- Owner reassigns to another registered user → `200` with updated record;
  the new owner is then authorized to PATCH the same taxon, the old owner
  is **not** (verifies §14 bullet 3, unilateral reassignment).
- Owner changes both `name` and `owner` in one call → `200`; both are
  applied atomically (verify with a follow-up GET).
- Owner reassigns to self → `200` no-op (decision #8).
- `name` set to the same value the taxon already has → `200` no-op
  (validation re-runs trivially and passes).

Resource / authorization:

- Unknown id → `404 not_found`.
- Non-owner, otherwise-authorized caller → `403 forbidden`.
- Null user → `403`.
- Unregistered well-formed caller → `403`.
- Malformed `X-Username` → `400`.

Body validation (decision #9):

- `{}` empty body → `400 validation_error` (decision #1).
- `{ foo: 1 }` no recognized keys → `400 validation_error` (same reason).
- `{ name: 123 }` non-string → `400`.
- `{ name: "" }` empty string → `400`.
- `{ name: " Leading" }` and `{ name: "Trailing " }` → `400`.
- `{ owner: null }` → `400`.
- `{ owner: "" }` → `400`.
- `{ owner: 42 }` non-string → `400`.
- `{ owner: " spaced " }` malformed username → `400`.
- `{ owner: "unregistered" }` well-formed but not in registry → `400`
  (per decision #9, this is request-content validation, not the caller's
  §4 gate).
- Unknown keys alongside a valid change (`{ name: "X", foo: 1 }`) → `200`
  (decision #6, lenient).

Invariant 3 (name uniqueness) at the HTTP boundary:

- Renaming to a value that collides with a sibling under the same root,
  exact match → `409 conflict` with a reason naming the clash.
- Renaming to a case-variant of an existing sibling name → `409`
  (case-insensitive per §3.4).
- **Cross-tree rename (the keystone case, §3.3 / §14 bullet 5).** Taxon
  X is shared between trees R1 (owned by Alice) and R2 (owned by Bob).
  Under R2 there's a sibling named `"Foo"` but no such name in R1. Alice
  (X's owner) PATCHes X's name to `"Foo"` — valid in R1, invalid in R2 →
  `409`. Verifies that the invariant module's "every containing tree"
  check is plumbed through the edit endpoint.
- A rename that doesn't clash anywhere → `200`, name updated globally
  (visible from every containing tree).

State integration:

- Post-rename, both trees containing the renamed shared taxon show the
  new name in `GET /trees/{root}`.
- Post-owner-reassignment, the new owner can PATCH and DELETE the
  taxon; the old owner is forbidden.

### 4. Edge add — `taxaEdgeAdd.test.ts`

`PUT /taxa/{parentId}/children/{childId}` end-to-end.

Happy paths:

- Parent owner adds a previously-disconnected taxon as a child → `204`;
  parent's `childIds` includes the child; child's `parentIds` includes
  the parent.
- Re-adding an already-existing edge → `204` idempotent (decision #2);
  no duplicate entries in `childIds` or `parentIds`.
- Adding a child to a parent in a different tree — making the child
  **shared** across trees — succeeds (§3.3 permits cross-tree diamonds);
  follow-up reads show the child in both trees.

Resource / authorization:

- Unknown parent id → `404 not_found`.
- Unknown child id → `404`.
- Both unknown → `404`.
- Caller is not the parent's owner → `403 forbidden`. (Even if caller
  owns the child — §6.4 vests the right in the parent's owner.)
- Null user → `403`.
- Unregistered → `403`.
- Malformed `X-Username` → `400`.

Invariant violations (each → `409 conflict` with a reason naming the
offending invariant and taxon(s)):

- Self-loop `PUT /taxa/X/children/X` → cycle.
- Adding an ancestor as a child of a descendant (deeper cycle) → cycle.
- Adding a child whose subtree creates an **in-tree diamond** under the
  parent's tree (the child is already reachable from the same root
  through a different path).
- Adding a child whose name (or any taxon in its subtree's name) clashes
  with an existing taxon in the parent's tree.
- Adding a child whose subtree, after attachment, would have its **own**
  internal name-clash within the resulting tree (e.g., the parent's tree
  already contains "Fantasy", the child being grafted carries another
  "Fantasy" inside it).

Cross-tree subtleties:

- The same child name allowed under two **different** trees (a sibling
  named "Fantasy" in tree R1 doesn't block adding a *different* taxon
  named "Fantasy" under tree R2) — `204`.
- Adding a shared child to a third tree → `204` if no clash; the
  invariant module is re-evaluated across the new combined trees.

### 5. Edge remove (detach) — `taxaEdgeRemove.test.ts`

`DELETE /taxa/{parentId}/children/{childId}` end-to-end.

Happy paths:

- Parent owner detaches a child that has no other parents → `204`; the
  child becomes a root (visible in `GET /trees`), its subtree is intact.
- Parent owner detaches a shared child (multiple parents) → `204`; the
  child retains its other parents and remains in their trees; the child's
  subtree is intact.
- Detach is detach, not delete (§7): the child still appears in
  `GET /taxa` after the detach. **Smoke against the §7 distinction.**

Resource / authorization:

- Unknown parent id → `404`.
- Unknown child id → `404`.
- Both exist but no edge between them → `404` (decision #3).
- Non-parent-owner caller → `403`.
- Null user → `403`.
- Unregistered → `403`.
- Malformed `X-Username` → `400`.

No invariant checks on detach (§6.4, §7): removing an edge can never
*create* a cycle, an in-tree duplicate, or a name clash. A test that
intentionally attempts a detach on a structure where every other invariant
violates (e.g., a fixture-induced state pre-existing) confirms the detach
is allowed — though under normal Phase-4 operation, such a state can't
arise.

### 6. Delete — `taxaDelete.test.ts`

`DELETE /taxa/{id}` end-to-end. This is the longest group; §6.3 is the
subtlest part of the phase.

Happy paths — region computation:

- **Lone root, no children.** Region is `{N}`. Both preconditions hold
  trivially. → `204`. Post-state: N is gone; `GET /taxa/N` → 404.
- **Root with U-owned children only.** Region is N + all descendants
  (since every path is wholly U-owned). → `204`. Every region taxon is
  gone; `GET /trees` no longer lists N; `GET /taxa` no longer lists any
  region taxon.
- **Deep U-owned subtree (3+ levels).** Region includes every level. →
  `204`. Smoke that the region walk follows arbitrary depth.
- **Non-root N with exactly one parent owned by U.** Region is N + its
  U-owned descendants; the edge from N's parent to N is removed (the
  parent itself survives — it's not in the region). → `204`. Parent's
  `childIds` no longer includes N.

Halt-frontier — the §14 bullet 4 case:

- **Single other-owned child at the halt point.** N (Alice) has a child
  C (Bob); the cascade halts at C. → `204`. Region: `{N}`. Post-state: N
  is gone; C is **not** deleted; the edge from N to C is removed
  (`parentIds` for C no longer contains N); if C had no other parents, C
  is now a root (visible in `GET /trees`).
- **Other-owned child has other parents — survives in those trees.** C
  (Bob) has parents N (Alice, being deleted) and M (some other taxon,
  not in any deletion path). → `204`. The N→C edge is removed; C remains
  in M's tree; C is **not** a root.
- **Stranded U-owned descendants downstream of an other-owned halt
  point** (§14 bullet 4 explicit consequence). Shape: N (Alice) → C
  (Bob) → D (Alice). The cascade includes N but halts at C → C survives
  detached from N; D survives **even though Alice owns it**, because
  the only path to D from N goes through Bob's C. After delete: N is
  gone; C is now a root with D still beneath it; D is still owned by
  Alice. This is the explicit "stranded" case.
- **Halt-frontier with multiple other-owned children.** N (Alice) has
  three children: U1 (Alice), C1 (Bob), C2 (Carol). Region = `{N, U1}`
  (and U1's wholly-Alice subtree). C1 and C2 each have the N→Ci edge
  removed; both survive.
- **Halt-frontier interleaved at multiple depths.** N (Alice) → U1
  (Alice) → C (Bob) → U2 (Alice). Region = `{N, U1}`. C and U2 are
  preserved; the edge U1→C is removed (because U1 is being deleted); C
  remains a root (or attached to its other parents); U2 remains attached
  beneath C. This pins that the halt-and-detach behavior applies at
  every level the cascade reaches it, not just the top.

Precondition 1 — region contains a shared taxon (§6.3):

- **N itself is shared** (has parents in two trees). → `409 conflict`,
  message identifies N as shared. No state changes.
- **A U-owned descendant in the region is shared** into another tree
  (i.e., has another parent outside the region). → `409`, message
  identifies the offending descendant. No state changes.
- **A U-owned descendant beneath an other-owned halt point is shared.**
  This descendant is NOT in the region (the cascade halts before
  reaching it), so it should NOT trigger precondition 1. → `204`; the
  shared U-owned descendant survives untouched (this is the
  precondition-1 parenthetical "Other-owned taxa at the halt frontier
  are not in the region and so may be shared"). Stretches the rule to
  the descendant case as well.
- **An other-owned halt-frontier taxon is shared** — explicitly permitted
  by §6.3 ("Other-owned taxa at the halt frontier are not in the region
  and so may be shared; they are merely detached from this tree, which
  is non-destructive."). → `204`; the other-owned taxon survives, edge
  to it removed.

Precondition 2 — N has zero parents or exactly one U-owned parent
(§6.3):

- **N has zero parents (root)** → satisfied. (Covered by happy paths.)
- **N has one parent owned by U** → satisfied. (Covered by happy paths.)
- **N has one parent owned by someone else** → `409 conflict`, message
  identifies the foreign-owned parent. Note: by precondition 1, an
  unshared N can have at most one parent — so this is the relevant
  precondition-2 failure shape.
- **N has multiple parents** — under normal Phase-4 state, this would
  imply N is shared (different roots) → precondition 1 trips first. The
  test pins which of the two preconditions is reported; the spec is
  silent on order, so the test accepts **either** 409 reason as long as
  one of them is reported (documenting the implementation's choice in
  the final plan).

Authorization:

- Non-owner caller → `403 forbidden`. No state changes.
- Null user → `403`.
- Unregistered → `403`.
- Malformed `X-Username` → `400`.
- Unknown id → `404`.

Atomicity (§11.1 + §6.3):

- A delete that fails a precondition leaves the graph **byte-identical**
  to the pre-call state (no partial cascade, no partial detachments).
- A successful delete removes every region taxon and every halt-frontier
  edge in one observable step (no intermediate state visible via reads
  is asserted because reads don't lock; the test instead asserts post-
  state and verifies pre-state is unchanged on the failure path).

### 7. Write serialization at the HTTP boundary — `writeSerialization.test.ts`

End-to-end tests of the §11.1 guarantee, using the in-process Hono app.

- Two writes dispatched in the same tick (no `await` between
  `app.request` calls) complete in order. Constructive form: A creates
  taxon T1 and renames T1; the rename's response shows T1 already
  exists.
- A `POST /taxa` and a `PATCH /taxa/{newId}` dispatched together — the
  PATCH addresses the ID returned by the POST. The PATCH succeeds (proving
  the POST committed first) rather than 404ing on a not-yet-committed id.
- `POST /reset` runs under the lock (decision #11): a write dispatched
  before `/reset` and one dispatched after observe the expected pre/post
  reset state. (Verifies the §15 "runs under §11.1" clause and Phase 3's
  reset-clears-state contract still holds.)
- Reads are NOT lock-serialized: a `GET /taxa` issued concurrently with
  a slow write doesn't block. (Best-effort smoke; JS's single-threaded
  loop makes a true race impossible without explicit `await`s.)

### 8. Integration across the phase — `phase4Integration.test.ts`

End-to-end stories tying multiple operations through `createApp` to
verify the phase composes correctly.

- **Multi-owner story.** Alice registers, creates a small tree, transfers
  the leaf to Bob via PATCH. Bob (now owner) renames the leaf — succeeds.
  Bob adds his own root and attaches the leaf under it via `PUT
  /taxa/.../children/...` (Bob now owns the parent; he uses his own
  parent's right). Alice attempts to delete her root and is blocked by
  precondition 2 (one of her root's children has a Bob-owned parent
  outside her tree, making it shared) — verify `409` with reason. Alice
  proposes the structural fix via a §6.4 detach on her own side (she's
  the parent of her tree). Now her tree's region is unshared. Alice
  retries DELETE and succeeds; Bob's tree remains intact.
- **§14 stranded-U-owned demonstration.** Build N(Alice) → C(Bob) →
  D(Alice). Alice deletes N. Result: N gone, C is now a root with D
  beneath it, D still owned by Alice. Verify via GETs.
- **Cross-tree-rename, end-to-end.** Build a shared taxon X between two
  trees with different sibling sets. PATCH-rename succeeds in one
  configuration and 409s in another that puts X's new name in conflict
  with a sibling in the *other* tree.
- **Reset between flows.** Build state, write some, `POST /reset`, then
  build different state; the new operations don't observe any residue
  (ID counter is back to `t1`; registry is empty; no taxa).

### 9. §15.6 envelope round-trips — folded into the per-op suites

Each write-path test that expects an error also asserts:

- HTTP status matches the §15.6 mapping (400 / 403 / 404 / 409).
- Response body is the envelope `{ error: { code, message, details? } }`
  with the expected `code` string.
- For 409 paths (invariant violations, delete preconditions), the message
  or `details` names the offending taxon / edge / name so a client can
  surface a useful error to the user. Tests don't pin the exact prose
  but do assert that the relevant ID(s) appear.

This is woven into groups 2–6 rather than collected separately, mirroring
how Phase 2 and Phase 3 distributed envelope-shape assertions across the
endpoint suites.

## Out of scope (deferred to later phases)

- Proposals (`POST /proposals`), latent/queued/accepted/rejected/invalid
  state machine (§11.2), routing (§10.1), queue-after-dependencies
  (§11.3), invalidation and dismissal (§11.4, §12.4) → Phase 5+.
- Review actions (single accept, cascade accept, reject, dismiss) → Phase
  5+.
- The `GET /queue` and `GET /proposals` reads → Phase 5+.
- Any read-time invariant validation (Phase-3 decision #5 remains in
  force; reads still mirror state verbatim).
- Cross-process / multi-instance concurrency — §11.1 is satisfied by an
  in-process serializer; the PRD does not require cluster-safety.

## Notes on test mechanics (per the toolchain supplement)

- Tests use `node:test` and `node:assert/strict`; no third-party
  framework, no third-party assertion helpers.
- Tests live under `test/`, are named `*.test.ts`, are compiled by `tsc`,
  and run via `node --test "dist/**/*.test.js"`.
- HTTP-level tests use `app.request(...)` against an in-process Hono app
  (no port binding).
- Per-test isolation: `POST /reset` runs before each test that touches
  server state; users are then explicitly registered as the test needs.
  No test depends on a specific server-assigned ID — IDs are captured
  from the create response (or the fixture primitive, where Phase-3-style
  hand-built structure is needed before a write-path test) and referred
  to by variable.
- Malformed-`X-Username` cases use NBSP for the leading/trailing
  whitespace character, per the Phase-2 final-plan note on HTTP OWS
  stripping. The §3.4 / §4 format rules themselves are unit-tested in
  Phase 1; the Phase-4 write tests only assert the chained outcome at
  the HTTP boundary.
- Names in tests draw from `prd/sample-taxonomy.md` (non-normative)
  where convenient — "Fiction", "Fantasy", "Epic Fantasy", etc. — and
  fabricate fresh names where the sample doesn't cover a needed shape
  (e.g., a deliberate clash on the second occurrence of "Fantasy").
- Where a test needs a pre-existing graph that Phase-4 writes can build
  themselves, it builds via the writes (POST /taxa + PUT
  /taxa/.../children/...). Where the test needs a deliberately
  invariant-violating shape to verify the *no-effect-on-failure*
  property of a write, it builds the shape via the Phase-3 fixture
  primitives and then asserts the write rejects it without mutating —
  but only on the failure path. The fixture primitives are not used to
  shortcut what writes can express.
