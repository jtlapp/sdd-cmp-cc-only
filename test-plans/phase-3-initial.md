# Phase 3 — Initial Test Plan (FROZEN)

This plan is written from the spec (`prd/prd.md` §2, §3 incl. §3.1–§3.4, §3.3
invariants, §13, §14, §15.2, §15.6 and `prd/phase-3-domain-invariants.md`)
**before implementation begins**. Once any implementation code lands, this file
is frozen and must not be edited. The phase's `phase-3-final.md` supersedes it
and records what was actually tested, with a changelog of differences.

## Scope under test

Phase 3 introduces:

- An **in-memory taxon store** (§2, §3.1): taxa with server-assigned IDs, name,
  owner, an outgoing child set, and a derived parent set; insertion-order
  iteration; reset-aware.
- A **reachability layer** (§3.2–§3.3): roots of the global graph, downward
  traversal from any taxon, the set of trees containing a given taxon, the
  `shared` predicate (reachable from more than one root), and in-tree
  duplicate-path detection.
- A pure, reusable **invariant module** (§3.3) evaluating all three invariants
  — no cycles, per-tree uniqueness of occurrence, per-tree name uniqueness
  (case-insensitive per §3.4) — over any candidate in-memory state, including
  multi-tree shapes (the cross-tree path for renames).
- The §15.2 **read surface**: `GET /taxa`, `GET /taxa/{id}`, `GET /trees`,
  `GET /trees/{rootId}`, behind the existing Phase-2 identity gate (null user
  is allowed to read).
- Reset (§15) extended: the taxon store and the server-side ID-generation
  state are cleared by `POST /reset`, which remains §4-exempt.

It does **not** include any taxon mutation (create / edit / delete / edge
add / remove), proposal submission, queues, or review actions — all explicitly
deferred to Phase 4+. Construction in this phase is exclusively through
**fixture primitives** exported from the taxon module for tests; those
primitives are deliberately non-validating so that tests can construct graphs
that violate each invariant and exercise the invariant module's negative paths.

## Resolved spec ambiguities (decided up front, recorded for traceability)

PRD §15.2 names the **fields** for each read but doesn't pin the JSON
**shapes**. PRD §2 leaves ID format implementation-defined. PRD §3.3 names
`shared` as a domain predicate but does not surface it on any read. These were
ambiguous when reading the cited sections; each is decided before tests are
written and is part of what this plan verifies.

1. **`GET /trees/{rootId}` shape is recursive-nested.** The response is the
   root taxon expanded as `{ id, name, owner, children: [ {…recursive…} ] }`.
   §3.3 invariant 2 guarantees that within a well-formed tree no taxon appears
   twice, so the recursion terminates without revisits on any state the phase's
   write paths would have produced (Phase 4+). Reads in Phase 3 do not pre-check
   invariants (reads only mirror current state — see decision #5), so for the
   sole purpose of tests that deliberately seed an *invalid* graph and then
   call this endpoint, the traversal is documented as breadth-first with each
   taxon expanded **at most once** at its first visit (revisits surface only
   their id under a sibling slot to keep the response finite). The intent is
   that production state, gated by Phase 4 invariants, will never trigger that
   branch — it exists only so a fixture-induced violation doesn't recurse
   forever.

2. **`GET /trees` per-entry shape mirrors `GET /taxa/{id}`.** Each entry is
   `{ id, name, owner, childIds, parentIds }`. For roots, `parentIds` is always
   `[]`. Chosen so the four reads share one taxon-record shape; deferring a
   smaller `{ rootId, name, owner }` form unless Phase 4+ needs it.

3. **`/trees/{id}` where `id` names an existing non-root taxon → 404
   `not_found`.** The `/trees/` namespace is keyed by *root* taxa (PRD §3.2:
   "A tree is identified by its root taxon's ID"); a non-root taxon does not
   identify a tree. Returning its subtree under that path would conflate
   "subtree" with "tree" and would be misleading. The 404 message names the
   reason (taxon exists but is not a root) to keep it distinguishable from a
   genuinely missing id.

4. **Ordering is insertion order across the board.** `GET /taxa` and
   `GET /trees` list in creation order; `childIds` lists in
   parent→child-edge attachment order; `parentIds` lists in the order each
   parent acquired this child. §3.1 marks children as "unordered relative to
   one another," so any deterministic order satisfies the model; insertion
   order is chosen because it matches Phase 2's `GET /users` choice and is
   trivially reproducible from the underlying maps.

5. **Reads return current state verbatim.** Read endpoints do not run the
   invariant module before responding. The invariant module is consulted by
   *writes* (Phase 4+); read endpoints in Phase 3 are pure projections of the
   store. This matters because Phase 3 tests deliberately seed invariant
   violations to exercise the invariant module, and those graphs must still be
   readable through `GET /taxa` / `GET /taxa/{id}` while a `GET /trees/{root}`
   call on the same graph follows decision #1's revisit-finitization rule.

6. **Taxon IDs are opaque monotonic strings** of the form `t1`, `t2`, … —
   implementation-defined per §2. Tests must not assume specific values; they
   capture the id returned by the construction primitive and refer to it by
   variable. `POST /reset` resets the counter back to `t1`.

7. **The `shared` predicate is NOT on the read surface.** §15.2 lists the
   fields for each read; `shared` is not among them. The predicate is exported
   from the reachability module for the invariant module's internal use (and
   for Phase 4+'s deletion preconditions, §6.3). Tests verify the predicate
   directly, not through any HTTP response.

8. **Fixture primitives bypass invariant enforcement.** The taxon module
   exports module-level primitives for tests to construct taxa and edges
   directly (no HTTP). These are deliberately non-validating because the
   invariant module must be testable on graphs that *violate* each invariant.
   Phase 4 will introduce validating mutation paths on top of the same store
   primitives; those are out of scope here.

9. **Invariant-module API is state-based.** The module exposes pure functions
   over a state value (`checkNoCycles`, `checkPerTreeUniqueOccurrence`,
   `checkPerTreeNameUniqueness`, plus a combined `evaluateAll`). To check a
   proposed change, the caller (Phase 4+) materializes "state + change" and
   re-evaluates. Change-shaped probes (e.g. `wouldAddEdgeViolate`) are not
   exposed in Phase 3 — the brief lets the module accept either form, and the
   state-based form is sufficient for the cross-tree path and for downstream
   reuse.

10. **Violation results name the offender.** `evaluateAll` returns either
    `{ ok: true }` or `{ ok: false, violations: [...] }` where each violation
    carries enough structure (invariant kind + offending taxon(s) / edge /
    root / clashing-name) for Phase 4 to surface §15.6 `conflict` reasons
    without re-deriving them. The exact field shape is internal to the module;
    tests pin the shape so future refactors don't silently drop information.

## Coverage dimensions (per the brief)

- **New behavior** — the in-memory store, the reachability layer, the read
  endpoints, and each §3.3 invariant including boundary conditions where a
  rule's outcome changes. Exercise the invariant module **directly** against
  in-memory graphs (hand-built via the fixture primitives), including
  multi-tree shapes.
- **Interactions with earlier phases** — reads sit behind Phase 2's
  `identityWithRegistry` middleware; the §15.6 envelope and 404 fallback from
  Phase 1 still apply. Name comparison in invariant 3 uses §3.4's
  case-insensitive rule, the same comparator the Phase-1 / Phase-2 layers
  already established for names and usernames.
- **Failure and invalid states** — the module's behavior on graphs that
  violate each invariant, distinguishing the three invariants from one
  another (a cycle is reported as a cycle, not as an in-tree duplicate; an
  in-tree diamond is reported as a duplicate, not as a name clash; etc.).

Per §14 (accepted properties), these are intended behaviors to verify, not
bugs to fix.

## Test groups

Files are named to mirror the modules they exercise, matching the Phase 1–2
convention.

### 1. Taxon store + ID generation + reset — `taxa.test.ts`

Unit tests against the store primitives (no HTTP):

- A freshly-reset store has zero taxa; `allTaxa()` returns `[]`.
- Constructing a taxon returns a fresh server-assigned ID; consecutive
  constructions return distinct IDs in monotonic order (decision #6).
- A constructed taxon starts with the supplied name + owner, an empty child
  set, and no parents (it is a root until attached).
- Attaching a child edge appears on the parent's `childIds` (in attachment
  order, decision #4) and on the child's derived parent set (in the order
  each parent acquired this child).
- Detaching an edge (via the fixture primitive; the user-facing detach is
  Phase 4) removes it from both ends.
- A constructed graph survives across reads but `POST /reset` empties the
  store **and** resets the ID counter back to `t1` (decision #6).
- Reset clears even after non-trivial graphs (multiple roots, multiple
  edges) — no residual taxa, no residual edges, no residual ID counter.
- Multiple `clear` registrations are independent: clearing taxa does not
  disturb the Phase-2 registry beyond what its own `clear` handles
  (smoke-checked end-to-end in the integration suite, below).

### 2. Reachability — `reachability.test.ts`

Pure-function tests against hand-built graphs (no HTTP). Each test states
the graph shape inline so the assertion is self-evident.

Roots:
- Empty graph → `roots()` is `[]`.
- A single isolated taxon is its own root.
- A linear chain `A → B → C`: `roots = [A]`.
- A diamond *across two trees* — `A → C`, `B → C`, both `A` and `B` roots —
  `roots = [A, B]`; `C` is not a root.
- Detaching the only incoming edge to `C` (so `B → C` is removed): `C`
  becomes a root.

Containing trees:
- For each taxon in the chain `A → B → C`: `treesContaining(A) = {A}`,
  `treesContaining(B) = {A}`, `treesContaining(C) = {A}`.
- In the cross-tree diamond above, `treesContaining(C) = {A, B}`.
- For a deeper graph (`A → B → D`, `C → D`): `D` is in trees `{A, C}`; `B`
  is in tree `{A}` only.
- A taxon with no parents: `treesContaining(X) = {X}` (it is its own tree).

`shared` predicate:
- An isolated root → not shared.
- A linear-chain taxon → not shared.
- A taxon reachable from two distinct roots → shared.
- A taxon reachable from the same root by two distinct in-tree paths
  (in-tree diamond — invariant 2 violation) → **not** shared, because
  `|treesContaining| = 1` (the same root counted once). The duplicate-path
  case is the invariant-2 concern, distinct from `shared`.

In-tree duplicate detection (a building block for invariant 2):
- A clean tree (no duplicates) → the traversal reports no in-tree duplicates.
- An in-tree diamond `R → A`, `R → B`, `A → X`, `B → X` (so `X` is
  reachable from `R` by two paths) → reported as a duplicate at `X` within
  tree `R`.
- A cross-tree diamond (decision #1 / §3.3 distinction) → **not** an
  in-tree duplicate; the two paths to the shared taxon are in different
  trees.

Descendants:
- Empty subtree (leaf) → `descendants(X) = {}`.
- Full reach: from the root of a 4-node tree, `descendants(root)` covers
  the other three.
- From a non-root taxon, `descendants(X)` is the strict-downward closure
  (not the full tree).

### 3. Invariant module — `invariants.test.ts`

Pure-module tests, hand-built graphs. Each invariant has both a passing
case and one or more failing cases; failures must distinguish themselves
from the other invariants.

§3.3 invariant 1 — **no cycles**:
- A linear chain → passes.
- A diamond across two trees → passes (no cycle).
- A self-edge `A → A` → fails; the violation names `A` and the cycle.
- A two-cycle `A → B → A` → fails; the violation identifies both taxa and
  the back-edge.
- A three-cycle reachable only from a root chain (`R → A → B → C → A`) →
  fails; the violation is reported as a cycle (not as an in-tree
  duplicate, even though `A` is visited twice from `R`).
- The other two invariants pass on a graph that violates only cycles
  *only insofar as their evaluation is well-defined on a cyclic graph* —
  the module reports the cycle and does not falsely report duplicates or
  name clashes induced by the cycle.

§3.3 invariant 2 — **per-tree uniqueness of occurrence (no in-tree
diamond)**:
- A linear chain → passes.
- A cross-tree diamond `A → C, B → C` (two trees) → passes — diamonds
  across trees are permitted (§3.3).
- An in-tree diamond `R → A, R → B, A → X, B → X` → fails; the violation
  names `X` and root `R`.
- A deeper in-tree diamond several levels down → fails; violation names
  the duplicated taxon and the containing root.
- A taxon shared across trees that is *also* duplicated within one of
  those trees → fails on invariant 2 (the cross-tree sharing alone is
  fine; the in-tree duplication is what the violation reports).
- A graph with two independent in-tree diamonds in two different trees →
  both are reported.

§3.3 invariant 3 — **per-tree name uniqueness (case-insensitive)**:
- A tree where every name is distinct → passes.
- Two taxa with the same exact name in the same tree → fails; violation
  names the tree's root and the two taxa.
- Two taxa whose names differ only in case in the same tree (e.g.
  `"Fantasy"` and `"fantasy"`, or `"FANTASY"`) → fails (§3.4
  case-insensitive comparison).
- Two taxa with the same name in *different* trees → passes — name
  uniqueness is per-tree (§3.4).
- A **shared taxon** with a name that clashes with a different taxon in
  one of its containing trees → fails for that tree, with the violation
  naming the offending root.
- A **rename simulation** at the module level — i.e. construct two
  candidate states `before` and `after` where the only difference is one
  taxon's name — and verify the module catches a name clash that appears
  only in a tree the taxon shares into but did not originate in (the
  §3.3 cross-tree path). The brief's centerpiece: invariant evaluation
  must hold across **every** tree a taxon belongs to.

Multi-invariant cases (mutual independence):
- A graph that violates *only* invariant 1 → `evaluateAll` reports
  invariant 1, not 2 or 3.
- A graph that violates *only* invariant 2 → reports 2, not 1 or 3.
- A graph that violates *only* invariant 3 → reports 3, not 1 or 2.
- A graph that violates 2 and 3 → both are reported with their offending
  taxa correctly attributed (not conflated).

Result shape (decision #10):
- `evaluateAll(state)` on a clean graph returns `{ ok: true }`.
- On a violating graph, returns `{ ok: false, violations: [...] }` where
  each violation has an identifiable invariant kind and the structural
  details a Phase-4 caller would need to build a §15.6 reason. Tests pin
  the shape (kind + offender fields) without over-fitting to incidental
  ordering of the list.

### 4. Read endpoints — `reads.test.ts`

End-to-end through `createApp`, with state constructed via the fixture
primitives before each test (per the toolchain supplement, the test calls
`POST /reset` first and rebuilds its state explicitly).

`GET /taxa`:
- Empty store → `200 { taxa: [] }`.
- Two taxa A then B → `{ taxa: [A-record, B-record] }` in insertion order
  (decision #4). Each record has `{ id, name, owner, childIds, parentIds }`
  (decision #2).
- After attaching B as a child of A, A's record has `childIds: [B.id]` and
  B's record has `parentIds: [A.id]`.

`GET /taxa/{id}`:
- Existing id → `200` with the same record shape.
- Missing id → `404 not_found` via the §15.6 envelope.
- A shared taxon (reachable from two roots) lists both parents in
  `parentIds` in attachment order.

`GET /trees`:
- Empty store → `200 { trees: [] }`.
- A graph with two roots A, C and chains under each → `{ trees: [A-record,
  C-record] }`; each entry has `parentIds: []` (decision #2) and the
  root's own `childIds`.
- A graph where a previously-root taxon has been attached under another
  parent → the previously-root no longer appears in `trees`.

`GET /trees/{rootId}` (decisions #1, #3):
- A root with no children → `{ id, name, owner, children: [] }`.
- A root with two children → `children` lists both (insertion-order), each
  with its own (possibly empty) `children`.
- A root with a deeper subtree → fully recursive expansion; the depth is
  whatever the fixture built.
- A **shared** child (reachable from two roots) — calling `/trees/{r1}` and
  `/trees/{r2}` each shows the shared child under its respective parent;
  the two responses are independent expansions.
- A non-root but existing taxon id → `404 not_found`, message distinguishes
  "not a root" from "no such taxon" (decision #3).
- A missing id → `404 not_found`.
- **Defensive case (decision #1):** a fixture-induced in-tree diamond is
  served by `/trees/{rootId}` finitely; the duplicated taxon appears
  expanded at its first visit and is not re-expanded at the second visit.
  This is documented as a Phase-3 contract because Phase 3 has no write
  path to enforce invariant 2; Phase 4+ writes guarantee the case can't
  arise in production state.

Identity gate on reads (interaction with Phase 2):
- All four endpoints with **no `X-Username`** → `200` (null may read,
  §15.2).
- All four endpoints with a **registered** `X-Username` → `200`.
- All four endpoints with an **unregistered** `X-Username` → `403
  forbidden` (Phase-2 decision #2).
- All four endpoints with a **malformed** `X-Username` (NBSP-prefixed, per
  Phase-2 final-plan note on HTTP OWS handling) → `400 validation_error`.

### 5. Reset extends to taxa — `reads.test.ts` (or a dedicated `resetTaxa.test.ts` if it grows)

- After constructing taxa + edges, `POST /reset` empties `GET /taxa` and
  `GET /trees`.
- After reset, a previously-issued taxon id (e.g. `t1`) returns 404 on
  `GET /taxa/{id}` and `GET /trees/{id}`.
- After reset, the next constructed taxon receives `t1` again (the ID
  counter is reset, decision #6).
- Reset remains callable by null, unregistered, and malformed-header
  callers — the §4 exemption is preserved alongside the new state
  clearing.
- Resetting also clears any leftover Phase-2 registry state in the same
  call (smoke; the registry's own clear is already tested in Phase 2,
  this just confirms both registrations of `clear` fire under one call).

### 6. Integration through `createApp` — `domainIntegration.test.ts`

End-to-end smoke combining registration + fixture-built graph + the four
reads + reset, mirroring Phase 2's `usersIntegration.test.ts`:

- Register Alice and Bob; construct a multi-tree graph owned across the
  two; hit each of the four reads as Alice, as the null user, and as an
  unregistered caller (the latter → 403).
- Verify the §15.6 envelope codes (400, 403, 404) round-trip through the
  Phase-1 envelope helpers from the new routes, identically to Phase 2.
- `GET /taxa/{missing}` and `GET /trees/{missing}` use the same
  envelope; `notFound` for the *route* (e.g. `GET /taxa/`) still falls
  through to Phase 1's catch-all 404.
- After mid-flow `POST /reset`, the graph is gone and the registry is
  empty (chained with Phase 2's reset behavior).

### 7. Use of §14 accepted properties

Per the brief, §14 properties are intended behavior to verify. Phase 3
only exposes the *substrate* for several of them (the invariants and
`shared`); the property tests in this phase are limited to those parts:

- **Cross-tree name clash detection (§14 bullet 5).** A rename that would
  satisfy invariant 3 in the rename's "own" tree but violate it in another
  containing tree must be reported as a violation — covered in test group
  3's rename-simulation case.
- **Sharing as a first-class predicate (§14 bullets 2 and 4).** The
  reachability layer surfaces `shared`; tests for it (group 2) build the
  multi-parent shapes that §14 references in the deletion narrative, even
  though deletion itself is Phase 4.

The remaining §14 bullets (non-atomic moves, ownership reassignment,
cascade halting) depend on mutations and proposals and are out of scope
for this phase.

## Out of scope (deferred to later phases)

- Mutation endpoints (`POST /taxa`, `PATCH /taxa/{id}`, `DELETE /taxa/{id}`,
  `PUT/DELETE /taxa/{p}/children/{c}`) → Phase 4. Construction in this
  phase is fixture-only.
- Proposals (`POST /proposals`), the queue (`GET /queue`), and review
  actions (§15.5) → Phase 5+.
- Write serialization (§11.1) — Phase 3 has no write path to serialize.
- The `shared` field on reads, if it ever appears — Phase 4+ decision.
- Any change-shaped invariant probe (decision #9) — Phase 4+ decision.

## Notes on test mechanics (per the toolchain supplement)

- Tests use `node:test` and `node:assert/strict`; no third-party framework.
- Tests live under `test/`, are named `*.test.ts`, are compiled by `tsc`,
  and run via `node --test "dist/**/*.test.js"`.
- HTTP-level tests use `app.request(...)` against an in-process Hono app —
  no port binding.
- Tests that exercise server state call `POST /reset` first per the
  isolation rule; the fixture primitives are then used to seed the
  specific shape under test. Pure unit tests on the reachability and
  invariant modules pass state values explicitly and need no reset.
- Names in tests draw from `prd/sample-taxonomy.md` (non-normative) where
  convenient; tests freely fabricate names where the sample doesn't
  cover a shape we need (multi-root, deliberate name clash, etc.). No
  test depends on a specific server-assigned ID — IDs are captured from
  the fixture primitive and referenced by variable.
- Malformed `X-Username` tests use NBSP (` `) for the
  leading/trailing-whitespace character, per Phase 2's final-plan note on
  HTTP OWS stripping. The §3.4 / §4 format rules themselves are unit-tested
  in Phase 1; HTTP-level tests here only assert the chained outcome.
