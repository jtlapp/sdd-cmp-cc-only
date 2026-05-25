# Phase 3 — Final Test Plan

This supersedes `phase-3-initial.md` (frozen). It records what was actually
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

**181 tests total, all passing** (94 inherited from Phases 1–2; 87 new in
Phase 3).

## Resolved spec ambiguities (recorded for traceability)

Carried over from `phase-3-initial.md` (unchanged):

1. `GET /trees/{rootId}` returns the recursive-nested
   `{ id, name, owner, children: [ … ] }` shape; on a fixture-induced
   invariant-2 violation, a revisited taxon collapses to a bare `{ id }`
   stub on its second appearance to keep the response finite.
2. `GET /trees` per-entry shape mirrors `GET /taxa/{id}` — full taxon
   record with `parentIds: []` for the root.
3. `/trees/{id}` where `id` names an existing non-root taxon → `404
   not_found` with a message distinguishing "not a root" from "no such
   taxon".
4. Ordering is insertion order across the board (taxa creation, child
   attachment, parent acquisition).
5. Reads return current state verbatim — they do not run the invariant
   module before responding. The invariant module is consulted by writes
   (Phase 4+).
6. Taxon IDs are opaque monotonic strings `t1, t2, …`; `POST /reset`
   resets the counter to 0 so the next allocation is `t1` again.
7. The `shared` predicate is exported from the reachability module but is
   not on the read surface.
8. Fixture primitives bypass invariant enforcement — they exist so tests
   can construct deliberately invalid graphs to exercise the invariant
   module's negative paths.
9. The invariant module's public API is state-based (not change-shaped) —
   `checkNoCycles`, `checkPerTreeUniqueOccurrence`,
   `checkPerTreeNameUniqueness`, and a combined `evaluateAll`.
10. Violation results carry the invariant kind plus the offender details
    (taxa, root, name) that Phase 4 will surface in §15.6 conflict
    responses.

## What is tested

New Phase-3 files (under `test/`, named to mirror the modules they exercise):

- `taxa.test.ts` — store primitives, ID generation, edges, reset.
- `reachability.test.ts` — pure functions over hand-built graphs.
- `invariants.test.ts` — the keystone module: each invariant in isolation,
  the combined `evaluateAll`, and the cross-tree path for renames.
- `reads.test.ts` — the four §15.2 read endpoints end-to-end through
  `createApp`, plus reset behavior on taxa.
- `domainIntegration.test.ts` — integration smoke combining registration
  + a fixture-built multi-tree graph + the four reads + reset.

Phase 1 + 2 files are unchanged and still pass.

### 1. Taxon store + ID generation + reset — `taxa.test.ts`

15 tests.

- Freshly-reset store → empty taxa map and empty parents-of index.
- `createTaxonFixture` allocates `t1`, `t2`, `t3` monotonically.
- New taxa start as roots with empty child sets.
- Name and owner are stored verbatim (no format check in the store —
  Phase 4 will compose `validateTaxonName` / registry checks at the
  write boundary).
- Edges: insertion order on `childIds`; insertion order on the derived
  `parentIds`; idempotent re-attachment; symmetric detach; no-op on
  detaching a non-existent edge.
- `attachChildFixture` throws on unknown parent or unknown child
  (fixture-author bug, not a domain invariant — it's a programming
  error in the test).
- Deeper attachments preserve per-id distinctness.
- `clear()` empties the store AND resets the ID counter; the parents-of
  index is cleared with it; the next allocation reuses `t1`.
- `allTaxa()` iterates in creation order.

### 2. Reachability — `reachability.test.ts`

19 tests against hand-built graphs.

Roots:
- Empty graph → no roots.
- A single isolated taxon is its own root.
- Linear chain `A→B→C` → roots = `[A]`.
- Cross-tree diamond `A→C, B→C` → roots = `[A, B]`.
- Detach restores a previously-child taxon to root status.

Containing trees:
- Chain `A→B→C` → every taxon's containing tree is `{A}`.
- Cross-tree diamond → `C` is in `{A, B}`.
- Deeper multi-root graph (`A→B→D, C→D`) → `D ∈ {A, C}`, `B ∈ {A}`.
- A taxon with no parents is its own containing tree.
- Unknown id → `[]`.

`shared` predicate:
- Isolated root → not shared.
- Linear-chain taxon → not shared.
- Two-root reach → shared.
- In-tree diamond — the duplicated taxon is reachable by two paths from
  one root; `isShared` is **false** for it (because |containing-trees|
  is 1, not 2). The duplicate-path case is invariant 2's concern, not
  sharing's.

In-tree duplicates / visit counts:
- Clean tree → no duplicates.
- In-tree diamond → the duplicated taxon is reported.
- Cross-tree diamond → not reported as an in-tree duplicate from either
  tree.
- Visit-count semantics pinned on a diamond (root: 1, two intermediates:
  1, shared child: 2).

Descendants:
- Leaf → empty.
- From the root of a 4-node tree → the other three.
- Mid-tree → strict downward closure (the root is NOT a descendant).
- Cycle-safe — `A→B→A` traversal yields each node once, no infinite loop.

### 3. Invariant module — `invariants.test.ts`

24 tests covering each invariant in isolation, mutual independence, and
result-shape.

§3.3 invariant 1 — no cycles:
- Linear chain → passes.
- Cross-tree diamond → passes (no cycle).
- Self-edge `A→A` → fails; violation `{kind: "cycle", taxa: [A]}`.
- Two-cycle `A→B→A` → fails; violation names both taxa.
- Three-cycle reachable from root chain (`R→A→B→C→A`) → reported as a
  cycle (not as an in-tree duplicate even though A would be visited
  twice on a naive walk).
- A purely-cyclic graph (two-cycle, no roots) does NOT cause invariants
  2 or 3 to fire spuriously.

§3.3 invariant 2 — per-tree uniqueness of occurrence:
- Linear chain → passes.
- Cross-tree diamond → passes (diamonds across trees are permitted).
- In-tree diamond → fails; violation names the duplicated taxon and the
  containing root.
- Deeper in-tree diamond → still caught.
- Shared-across-trees AND duplicated-within-one-tree → fires ONLY for
  the in-tree case (the sharing is fine; only the duplication is the
  violation).
- Two independent in-tree diamonds in two different trees → both are
  reported.

§3.3 invariant 3 — per-tree name uniqueness (case-insensitive):
- Distinct names → passes.
- Exact-duplicate names in one tree → fails; violation carries the
  lowercased name and both taxa.
- Case-variant names (`Fantasy` / `FANTASY`) → fails (§3.4
  case-insensitive comparison).
- Same name across different trees → passes (per-tree only).
- A shared taxon clashing with a sibling in ONE of its containing trees
  → fires for that tree only.
- **Rename simulation (the cross-tree centerpiece, brief §15.2 / §3.3):**
  a taxon shared across R1 and R2 is renamed in memory to a value that
  collides with an existing sibling in R1 but not in R2. The invariant
  module catches the violation under R1 — implementing §3.3's "must
  satisfy invariant (3) in EVERY containing tree" for renames.

Mutual independence (the three invariants don't conflate):
- Only-cycle graph → reports cycle, not 2 or 3.
- Only-duplicate graph → reports duplicate, not 1 or 3.
- Only-name-clash graph → reports clash, not 1 or 2.
- A graph violating BOTH 2 and 3 reports both, each attributed to the
  correct taxa/root, with no false-positive cycle.

Result shape:
- Empty graph → `{ ok: true }`.
- A non-trivial clean multi-tree graph (with a legitimately shared taxon
  across two trees) → `{ ok: true }`.

### 4. Read endpoints — `reads.test.ts`

21 tests through `createApp`.

`GET /taxa`:
- Empty store → `{ taxa: [] }`.
- Multi-taxon graph → records in creation order with the full
  `{ id, name, owner, childIds, parentIds }` shape.

`GET /taxa/{id}`:
- Existing id → 200 with the record.
- Missing id → 404 with `not_found` envelope.
- A shared taxon's `parentIds` lists both parents in attachment order.

`GET /trees`:
- Empty store → `{ trees: [] }`.
- Two roots with chains → both appear with `parentIds: []`.
- A previously-root attached under another parent → it disappears from
  `/trees`.

`GET /trees/{rootId}`:
- Leaf root → `{ id, name, owner, children: [] }`.
- Two-children root → children in insertion order.
- Deeper subtree → fully recursive expansion.
- Shared child → fetching either root's tree shows the shared child
  under the appropriate parent.
- Non-root existing id → 404 with "not a root" message.
- Missing id → 404.
- **Fixture-induced in-tree diamond (decision #1):** the duplicated
  taxon is expanded under exactly ONE of its in-tree paths; the other
  path carries a bare `{ id }` stub. The response is finite.

Identity gate:
- Null user accepted on all four endpoints.
- Registered caller accepted on all four endpoints.
- Unregistered well-formed caller → 403 on all four (decision #2 from
  Phase 2).
- Malformed (NBSP-prefixed) caller → 400 on all four.

Reset extends to taxa:
- After taxa exist, `POST /reset` empties `/taxa` and resets the ID
  counter — the next allocation is `t1`.
- Post-reset, previously-issued ids 404 on both `/taxa/{id}` and
  `/trees/{id}`.
- Post-reset, `/trees` is empty.

### 5. Integration through `createApp` — `domainIntegration.test.ts`

4 tests.

- Register Alice + Bob, build a 4-taxon DAG where `Epic Fantasy` is
  shared between trees `Fiction` (Alice) and `Mystery` (Bob); exercise
  `/taxa`, `/taxa/{id}`, `/trees`, `/trees/{rootId}` as Alice / null /
  unregistered.
- §15.6 envelope codes (400 malformed, 403 unregistered, 404 unknown
  taxon) all round-trip through the Phase-1 envelope helpers from the
  new routes.
- Phase-1 catch-all `notFound` still applies to unknown route paths
  (e.g. `/taxa/some/deeper/path`).
- A single `POST /reset` wipes the registry AND the taxon store AND the
  ID counter in one call (cross-phase reset integration).

## Note on §14 accepted properties

Per the brief, §14 properties are intended behavior to verify, not bugs
to fix. Phase 3 verifies the substrate for two of them:

- **Cross-tree name clash detection (§14 bullet 5):** the rename
  simulation in `invariants.test.ts` proves a rename that satisfies the
  invariant in the rename's "own" tree but breaks it in another
  containing tree is caught — the cross-tree centerpiece of the brief.
- **Sharing as a first-class predicate (§14 bullets 2 and 4):** the
  reachability tests cover `isShared`'s distinction from in-tree
  duplication, on the multi-parent shapes §14 references.

The other §14 bullets (non-atomic moves, ownership reassignment,
cascade halting) depend on mutations and proposals and are out of scope.

## Out of scope (deferred to later phases)

Unchanged from the initial plan: mutation endpoints → Phase 4; proposals,
queues, and review actions → Phase 5+; write serialization → Phase 4;
`shared` field on reads (if ever) → Phase 4+; change-shaped invariant
probes → Phase 4+.

## Changelog vs. `phase-3-initial.md`

The plans match on **scope and behavior** to test. Differences are
implementation-time refinements that emerged once code existed:

- **Added: `attachChildFixture` throws on unknown parent or child.**
  Initial plan covered the happy paths only; the final taxa suite pins
  the "fixture-author bug" behavior: passing a bogus id is a programming
  error (throws), not a domain-invariant violation (which would be
  reported by the invariant module on a constructed graph). **Reason:**
  the distinction matters — a future Phase-4 write path will need to
  treat unknown ids as `404 not_found` user errors, NOT as cycles or
  duplicates. Pinning the fixture's "throw on unknown" behavior keeps
  that distinction visible.

- **Added: visit-count semantics pinned in reachability tests.**
  Initial plan listed `inTreeDuplicates` behavior; the final suite also
  exercises `inTreeVisitCounts` directly (`root: 1`, intermediates: `1`,
  duplicated child: `2` on a diamond). **Reason:** the invariant module
  consumes the visit-count map, not just the duplicate list; pinning
  the count values catches a future refactor that switches to a
  presence-only set.

- **Added: cycle robustness on `descendants`.** Initial plan didn't
  explicitly call out cycle-safety of the `descendants` traversal; the
  final suite adds a test that constructs `A→B→A` via fixtures and
  asserts the result is finite with each node visited once. **Reason:**
  reachability + invariant module both walk down through child sets;
  if any walker is not cycle-safe, the invariant tests that build
  cyclic graphs would hang instead of failing cleanly. Caught by
  the test that builds the three-cycle invariant-1 case.

- **Added: "non-trivial clean multi-tree graph" `evaluateAll` test.**
  Initial plan covered the empty-graph ok-case; the final suite also
  has a test that builds two trees with a legitimately shared taxon
  (different trees, no in-tree duplicates, distinct names per tree) and
  asserts `evaluateAll` returns `{ ok: true }`. **Reason:** without it,
  a regression that overzealously flags any sharing as a violation
  would pass the empty-graph happy path silently.

- **Added: Phase-1 `notFound` fallback assertion in the integration
  suite.** Initial plan deferred this as "smoke-only"; the final suite
  has a dedicated test for `/taxa/some/deeper/path` returning the
  Phase-1 envelope. **Reason:** matches Phase 2's choice to add the
  same explicit `/users/nope` test; confirms Phase-3 routing doesn't
  shadow the catch-all.

- **Refined: NBSP usage for malformed-`X-Username` tests.** Same issue
  the Phase 2 final plan documented (HTTP strips OWS; NBSP survives).
  An initial pass of the Phase-3 tests used regular spaces and the
  cases returned 403 instead of 400 — the server saw the trimmed
  `"alice"` and treated it as well-formed-but-unregistered. The final
  suite uses NBSP for those header values. **Reason:** the malformed
  branch must actually traverse the format check, not the registry
  gate. The Phase-1 `parseUsername` unit tests continue to cover OWS
  forms directly.

- **Added: cross-phase reset integration test.** Initial plan covered
  reset-clears-taxa in isolation; the final integration suite has one
  test asserting that a single `POST /reset` wipes the registry,
  the taxon store, AND the ID counter in one call. **Reason:** confirms
  the central `registerReset` seam composes Phase-2 and Phase-3
  cleanups correctly — a regression that registers only one of them
  would pass the focused per-module tests.

- **Added: stub-vs-full-expansion assertion in the fixture-diamond
  `/trees/{rootId}` test.** Initial plan promised "finite response";
  the final test pins that exactly one of the two occurrences is fully
  expanded with `name`/`owner`/`children` and the other is a bare
  `{ id }` stub. **Reason:** "finite" without a shape assertion would
  pass a degenerate implementation that strips `name`/`owner` from
  both occurrences. Decision #1 calls out the stub vs. full-expansion
  distinction explicitly.

No scenarios were removed.
