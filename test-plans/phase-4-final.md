# Phase 4 — Final Test Plan

This supersedes `phase-4-initial.md` (frozen). It records what was actually
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

**287 tests total, all passing** (181 inherited from Phases 1–3; 106 new in
Phase 4).

## Resolved spec ambiguities (recorded for traceability)

Carried over from `phase-4-initial.md` (unchanged):

1. `PATCH /taxa/{id}` with an empty body (`{}`) → `400 validation_error`.
2. `PUT /taxa/{parentId}/children/{childId}` when the edge already exists
   → `204` idempotent no-op.
3. `DELETE /taxa/{parentId}/children/{childId}` when both taxa exist but
   no edge connects them → `404 not_found`.
4. `DELETE /taxa/{id}` on success → `204 No Content`.
5. Validation precedence: identity → body parse → resource lookup (404) →
   authorization (403) → body field validation (400) → domain invariants /
   preconditions (409).
6. Unknown keys in PATCH bodies are ignored, not rejected.
7. Response shapes mirror Phase-3 reads (`POST` → `201` + record, `PATCH`
   → `200` + updated record, edge ops & `DELETE` taxon → `204`).
8. Setting `owner` to the current owner is a valid no-op.
9. PATCH body field validation distinguishes 400 (structurally invalid,
   including well-formed-but-unregistered owner) from 409 (structurally
   valid change that breaks a §3.3 invariant).
10. Cascade delete is atomic under the write lock.
11. `POST /reset` runs under the same write lock (§15).

## What is tested

Files mirror the modules they exercise, matching the Phase-1–3 convention.

- `writeLock.test.ts` — the §11.1 serializer primitive (5 tests).
- `taxaCreate.test.ts` — `POST /taxa` end-to-end (13 tests).
- `taxaEdit.test.ts` — `PATCH /taxa/{id}` end-to-end (23 tests).
- `taxaEdgeAdd.test.ts` — `PUT /taxa/{p}/children/{c}` (15 tests).
- `taxaEdgeRemove.test.ts` — `DELETE /taxa/{p}/children/{c}` (11 tests).
- `taxaDelete.test.ts` — `DELETE /taxa/{id}` end-to-end (21 tests).
- `deletion.test.ts` — pure planner unit tests over fixture state (9 tests).
- `writeSerialization.test.ts` — §11.1 at the HTTP boundary (4 tests).
- `phase4Integration.test.ts` — multi-step end-to-end stories (5 tests).

Phase 1–3 files are unchanged and still pass.

### 1. Write serializer — `writeLock.test.ts`

5 unit tests, no HTTP.

- Two writes started in the same tick run sequentially (the slow one
  finishes before the fast one starts).
- A write that throws does NOT stall subsequent writes; the rejection is
  surfaced to the caller but not poisoned onto the tail.
- An async write holds the lock until it resolves; writes queued behind
  it observe its committed state.
- Many writes (10) complete in submission order.
- The thrown error is the same object the caller sees back through its
  promise (identity, not wrapped).

### 2. Create — `taxaCreate.test.ts`

13 tests through `createApp`.

Happy paths:

- Registered caller, valid name → 201 + record with caller as owner,
  empty childIds and parentIds, monotonic ID.
- Consecutive creates issue distinct, monotonic IDs.
- Freshly created taxon appears in `GET /taxa`, in `GET /trees` (as a
  root), and in `GET /trees/{id}`.
- Two registered users each create their own taxa, owners distinct.

Authorization:

- Null user → 403.
- Unregistered well-formed caller → 403.
- Malformed (NBSP-prefixed) X-Username → 400.

Body validation:

- Invalid JSON → 400.
- Non-object body (array, string, number, null) → 400 (each case).
- Missing 'name' field → 400.
- 'name' not a string (number, null, true, array, object) → 400 (each).
- 'name' format violations (empty, leading/trailing whitespace inc.
  TAB/LF) → 400 (each).
- Unknown body keys including `owner` are ignored; the caller is the
  owner per §6.1.

### 3. Edit — `taxaEdit.test.ts`

23 tests through `createApp`.

Happy paths:

- Owner renames → 200 with updated record; follow-up GET reflects it.
- Owner reassigns to another registered user → recipient may then
  PATCH and DELETE; the old owner cannot (verifies §14 bullet 3,
  unilateral reassignment).
- Both `name` and `owner` in one call → both applied.
- Reassigning owner to self → 200 no-op.
- Setting name to the current value → 200 no-op.
- Case-only name change (`Fantasy` → `FANTASY`) → 200, casing updates.

Resource / authorization:

- Unknown id → 404.
- Non-owner caller → 403.
- Null user → 403.
- Unregistered caller → 403.
- Malformed X-Username (NBSP) → 400.

Body validation:

- Empty body `{}` → 400.
- Body with only unknown keys → 400.
- `name` not a string (number, null, true, array) → 400 (each).
- `name` format violations → 400 (each).
- `owner` malformed (non-string, null, true, empty, leading/trailing
  whitespace) → 400 (each).
- `owner` well-formed but unregistered → 400.
- Unknown keys alongside a valid change → 200.

Invariant 3 at the HTTP boundary:

- Rename to a sibling's exact name → 409 (`name_clash`).
- Rename to case-variant of a sibling → 409.
- **Cross-tree rename keystone (§3.3 / §14 bullet 5)**: shared taxon X
  in trees R1 (Alice) and R2 (Bob); R2 has a sibling "Foo" but R1
  doesn't. Alice's rename of X to "Foo" is valid in R1 but blocked by
  R2 → 409. Verifies the invariant module's "every containing tree"
  check is plumbed through PATCH.
- Rename that doesn't clash anywhere → 200, both containing trees show
  the new name.

§15.6 envelope round-trip:

- 409 carries `details: { kind: "name_clash", rootId, name, taxa: [...] }`
  with the lowercased name and the offending taxon IDs.

### 4. Edge add — `taxaEdgeAdd.test.ts`

15 tests.

Happy paths:

- Parent owner adds a previously-disconnected child → 204; edge appears
  on both ends.
- Re-adding an existing edge → 204 idempotent; no duplicate entries.
- Child attached under two different trees → both trees show it, child
  is shared.

Resource / authorization:

- Unknown parent → 404. Unknown child → 404.
- Non-parent-owner caller (even the child's owner) → 403.
- Null user → 403.
- Malformed X-Username → 400.

Invariant violations (each → 409 with the kind in `details.kind`):

- Self-loop `PUT /taxa/X/children/X` → cycle.
- Deeper cycle (attach ancestor under descendant) → cycle. Post-failure
  state byte-identical.
- In-tree diamond → `in_tree_duplicate`. Post-failure state unchanged.
- In-tree name clash → `name_clash`. Post-failure state unchanged.
- Grafting a subtree whose internal name clashes with the receiving
  tree → `name_clash`. (The "graft brings its subtree implicitly" angle.)

Cross-tree subtleties:

- Same name allowed under two different trees (different taxa).
- Generic byte-identical state assertion on rejected add.

### 5. Edge remove (detach) — `taxaEdgeRemove.test.ts`

11 tests.

Happy paths:

- Parent owner detaches a single-parent child → 204; child becomes a
  root (visible in `GET /trees`); child's subtree intact.
- Parent owner detaches a shared child → 204; child retains other
  parents.
- Detach preserves the child's subtree (§7 detach ≠ delete).

Resource / authorization:

- Unknown parent → 404. Unknown child → 404.
- Both exist but no edge → 404 (decision #3).
- Non-parent-owner → 403. Null user → 403. Unregistered → 403.
- Malformed X-Username → 400.

Detach is not delete (§7):

- Post-detach the child is still in `GET /taxa`.

### 6. Delete — `taxaDelete.test.ts`

21 tests. The longest group; §6.3 is the subtlest piece of the phase.

Region computation (happy paths):

- Lone root, no children → region `{N}`.
- Root with U-owned children only → cascade deletes everything.
- Deep U-owned chain (5 levels) → all deleted.
- Non-root N with one U-owned parent → N's region deleted; parent
  survives, edge gone.

Halt-frontier (§14 bullet 4):

- Single other-owned child at halt point — child not deleted, edge
  removed, child becomes a root.
- Halt-frontier child with another parent — survives, retains other
  parent.
- **Stranded U-owned descendant below an other-owned halt point**
  (`N(Alice) → C(Bob) → D(Alice)`) — D survives even though Alice owns
  it; C is now a root with D beneath it. The explicit §14-bullet-4
  case.
- Multiple other-owned children at the halt frontier — each detached.
- Halt-and-detach applies at every level, not just N's children
  (`N → U1 → C(Bob) → U2`).

Precondition 1 (no region taxon is shared):

- N itself is shared (two parents) → 409 `shared_in_region` naming N.
- A U-owned descendant in region is shared into another tree → 409
  naming the descendant.
- A stranded U-owned descendant beneath an other-owned halt that is
  shared does NOT trip P1 (not in region) → 204; descendant survives.
- An other-owned halt-frontier taxon is itself shared — permitted by
  the §6.3 parenthetical → 204; survives with its other parent.

Precondition 2 (no parent or single U-owned parent):

- N has one parent owned by someone else → 409 `parent_not_owned`
  naming the foreign owner.
- N has multiple parents (and is shared) → 409; test accepts either
  `shared_in_region` (P1 fires first) or `multiple_parents` (P2 fires
  first) — the spec is silent on order. The implementation reports
  `shared_in_region` first.

Authorization / resource:

- Non-owner → 403, no state changes.
- Null user → 403. Unregistered → 403. Malformed X-Username → 400.
- Unknown id → 404.

Atomicity:

- A precondition-failed delete leaves state byte-identical (asserted
  by comparing all-ids and spot-checking parentIds).

### 7. Pure deletion planner — `deletion.test.ts`

9 unit tests over fixture-built state. Complements §6 by pinning the
planner's behavior on shapes that would be awkward to express purely
through the Phase-4 writes.

- Lone root → region `[N]`.
- Wholly-U-owned subtree → entire subtree in region.
- Halt at other-owned child — region stops before it.
- Stranded U-owned descendant beneath halt — NOT in region.
- Precondition 1 — region taxon shared → `shared_in_region` with the
  offender id.
- Precondition 1 — a region descendant shared → `shared_in_region`
  with the descendant.
- Precondition 2 — foreign-owned parent → `parent_not_owned` with the
  parent id + owner.
- Precondition 2 — single U-owned parent → ok.
- Other-owned halt-frontier taxon that is itself shared does NOT trip
  P1 (only region members count).

### 8. Write serialization at the HTTP boundary — `writeSerialization.test.ts`

4 end-to-end tests.

- Two POST /taxa fired in the same tick produce distinct ids in
  submission order (queue order ↔ ID order via the monotonic counter).
- A PATCH chained off a POST's response sees the POSTed taxon.
- POST /reset runs under the lock (§15): writes before see pre-reset,
  writes after see empty state (registry cleared, ID counter restarts
  to `t1`).
- A PUT and a concurrent GET settle to a consistent post-write state.

### 9. Phase-4 integration — `phase4Integration.test.ts`

5 multi-step stories.

- Multi-owner: Alice creates, transfers ownership to Bob, Bob renames,
  Alice can't.
- §14 bullet 4 stranded-U-owned demonstration end-to-end through HTTP
  (`N(Alice) → C(Bob) → D(Alice)`, delete N).
- Cross-tree rename succeeds when safe, 409s when name conflicts in
  another containing tree; post-failure the name is the previous safe
  value.
- Reset between flows wipes everything; ID counter restarts.
- Precondition-failed delete → fix the structure → retry succeeds.

## Note on §14 accepted properties

Per the brief, §14 properties are intended behavior to verify, not bugs
to fix. Phase 4 verifies four of them:

- **Ownership reassignment is unilateral** (§14 bullet 3) — Edit suite
  test "owner reassigns to another registered user" and the integration
  suite multi-owner story.
- **Cascade deletion never removes other users' taxa** (§14 bullet 4) —
  Delete suite halt-frontier tests, including the explicit
  stranded-U-owned-descendant case; mirrored in the planner unit tests
  and the integration suite's end-to-end version.
- **Deletion may require collaboration** (§14 bullet 2) — Integration
  suite "blocked → fix → retry" story shows the structural workaround
  the owner must perform when a region member is shared.
- **Name uniqueness is enforced per-tree but names are global** (§14
  bullet 5) — Edit suite cross-tree rename keystone test and the
  integration suite cross-tree-rename test.

Non-atomic moves (§14 bullet 1) is a Phase-5+ proposal-layer property
and is out of scope here.

## Out of scope (deferred to later phases)

Unchanged from the initial plan: proposals (§8–§12) and the queue
(§15.4) → Phase 5+; review actions (§15.5) → Phase 5+; read-time
invariant validation remains as Phase-3 decision #5 (reads mirror
state verbatim); cross-process concurrency is not required.

## Changelog vs. `phase-4-initial.md`

The plans match on **scope and behavior** to test. Differences are
implementation-time refinements that emerged once code existed.

- **Added: dedicated `deletion.test.ts` for the planner.** The initial
  plan grouped every delete-related test under `taxaDelete.test.ts`
  (end-to-end through HTTP). The final suite carves out a pure-unit
  layer for `planDeletion` that operates on fixture-built state.
  **Reason:** the planner is a pure function and benefits from unit
  tests that aren't gated on HTTP plumbing. The HTTP tests in
  `taxaDelete.test.ts` still cover the same scenarios end-to-end; the
  unit tests pin the planner's contract independently. The split
  followed the Phase-3 pattern of unit-testing pure modules separately
  from their HTTP exposure (cf. `invariants.test.ts` /
  `reachability.test.ts`).

- **Added: malformed-X-Username uses NBSP everywhere, not regular
  space.** During first-run of the suite, four of the malformed-header
  tests (in edit/edge-add/edge-remove/delete) returned 200/204
  instead of 400 because Hono's `app.request(...)` constructs a
  `Request` whose `Headers` strip leading/trailing ASCII whitespace
  from string values. The Phase-2 final plan already noted the same
  fact at the HTTP layer. **Resolution:** every malformed-X-Username
  test uses U+00A0 (NBSP) for the leading whitespace character, which
  survives normalization and reaches `parseUsername` as malformed.
  This matches the convention Phase-3's `reads.test.ts` adopted for
  the same reason.

- **Added: state-byte-identical assertions inline with several
  rejected writes**, not only the dedicated atomicity test. Initial
  plan called out the byte-identical assertion as a single test in
  the delete suite. The final suite asserts state unchanged inline
  with each rejected PUT-edge invariant case (cycle, in-tree
  duplicate, name clash). **Reason:** these are independent rollback
  code paths; a regression in any one would still pass the dedicated
  delete-atomicity test if the rollback in the affected handler had
  regressed.

- **Added: a "graft-subtree-clash" edge-add test.** Initial plan
  listed it as one of several invariant cases ("Adding a child whose
  subtree, after attachment, would have its own internal name-clash
  within the resulting tree"); the final suite implements it
  explicitly with a hand-built G subtree carrying its own "Fantasy"
  alongside the receiving tree's "Fantasy". **Reason:** it's the
  closest Phase-4 analogue to the Phase-5 graft operation, exercising
  the "child brings subtree implicitly" angle even though grafts
  proper are deferred. Confirming the invariant module catches it
  here means Phase 5's graft routing won't need a new invariant
  pathway.

- **Refined: precondition-2 multiple-parents test accepts either
  precondition's reason.** Initial plan noted the test should "pin
  which of the two preconditions is reported; the spec is silent on
  order, so the test accepts either 409 reason as long as one of
  them is reported." The final test does exactly that and documents
  in a comment that the implementation reports `shared_in_region`
  first (P1 in the loop precedes P2). **Reason:** keeps the contract
  honest with the spec — the implementation's order is not normative,
  so the test would fail spuriously if a future refactor reordered
  the precondition checks but still surfaced the correct error
  category.

- **Added: PATCH "case-only name change" success test.** Initial plan
  covered "rename to a value with the same case-insensitive identity
  as a sibling" (clash) but not "rename to a case-variant of the
  taxon's OWN name". The final suite adds a test asserting `Fantasy`
  → `FANTASY` succeeds and the casing updates. **Reason:** the
  invariant module groups by `.toLowerCase()`, so the taxon being
  renamed has the same case-insensitive key as itself — a naive
  duplicate-finding implementation might falsely flag this as a
  self-clash. Pinning the success case forecloses that regression.

- **Added: writeSerialization "POST /reset under the lock" test
  asserts ID counter restart and registry clear** in a single
  sequence. Initial plan named the requirement ("`POST /reset` runs
  under the lock"); the final test exercises both observable
  consequences (Alice no longer registered after reset; next create
  receives `t1`). **Reason:** the test is the only place that pins
  these two reset behaviors as ordered consequences of a single
  /reset under the write lock.

- **Added: Phase-4 integration "blocked → fix → retry" delete story.**
  Initial plan listed it as a multi-step bullet under §14 bullet 2.
  The final suite implements it as a single end-to-end test:
  Alice's first delete fails P1, she detaches the offending edge
  herself (a §6.4 detach she has the right to perform), her retry
  succeeds. **Reason:** captures the §14 "deletion may require
  collaboration" narrative without needing the proposal subsystem —
  Alice can fix the shape unilaterally on her own side. Phase 5+ will
  add the cross-owner case.

No scenarios were removed.
