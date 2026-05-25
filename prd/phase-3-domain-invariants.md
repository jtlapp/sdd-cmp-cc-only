# Phase 3 — Domain model and the invariant engine (keystone)

**Position:** Depends on Phases 1–2.
**Authoritative PRD sections:** §3 (§3.1–§3.4), §3.3 invariants, §15.2 reads.
§2 for ID generation and in-memory state.
**Source of truth:** `prd.md`. Where this brief restates a requirement, the
PRD's wording governs.

## Goal

Build the in-memory domain and — the centerpiece of this phase — a **pure,
reusable invariant module** that every later write path calls into instead of
re-deriving the rules. Unit-test that module by constructing graphs directly in
memory, before any API write exists.

## In scope

1. **State + entities (§2, §3.1).** The in-memory store, the taxon entity
   (server-assigned unique ID, name, owner, child set, derived parent set), and
   server-side ID generation (clients never mint IDs).
2. **Reachability layer (§3.2, §3.3).** Roots and the tree reachable from a root;
   which trees contain a given taxon; in-tree reachability and duplicate-path
   detection; and the `shared` predicate.
3. **Invariant engine (§3.3) — build as a pure module.** A single module that,
   given a candidate state or a proposed change, evaluates the three §3.3
   invariants (with the §3.4 case-insensitive comparison where §3.3 specifies
   it), and supports checking across **every** tree a taxon belongs to.
   Everything downstream calls this module rather than re-implementing any
   invariant check.
4. **Read surface (§15.2).** `GET /taxa`, `GET /taxa/{id}`, `GET /trees`,
   `GET /trees/{rootId}`, returning the fields listed in §15.2, available to all
   users including null.

## Explicitly deferred

- All mutations (create/edit/delete/edge) → Phase 4. Seed state in this phase
  only through test fixtures / direct in-memory construction.
- Proposals and anything in §8–§12 → Phases 5–7.

## Implementation note

Keep the invariant module free of HTTP and storage-mutation concerns so it can
be unit-tested against hand-built graphs. This is the single most reused piece
of logic in the system.

## Testing (per §13)

This phase must ship an automated test suite covering the behavior it
introduces. Per §13, choosing and structuring the specific scenarios is your
responsibility — they are deliberately not enumerated here. Aim for thoroughness
along these dimensions:

- **New behavior** — the reachability layer, the read endpoints, and each §3.3
  invariant, including boundary conditions where a rule's outcome changes.
  Exercise the invariant module directly against in-memory graphs, including
  multi-tree shapes.
- **Interactions with earlier phases** — reads and validation should respect the
  identity rules from Phase 2 and the format rules from Phase 1 where relevant.
- **Failure and invalid states** — the module's behavior on graphs that violate
  each invariant, distinguishing the three invariants from one another.

Treat the §14 "accepted properties" as intended behavior to be verified, not
bugs to be fixed. If, while implementing, you identify cases the spec implies
that these dimensions don't obviously cover, add tests for them.

Alongside the implementation and tests, deliver **two test-plan artifacts**
for this phase:

1. an **initial test plan**, written from the spec *before* implementation
   begins, listing what you believe needs testing for this phase and why. Once
   implementation starts this file is **frozen** — do not edit it afterward.
2. a **final test plan**, delivered at the end, that supersedes the initial one
   and reflects what was actually tested, plus a short **changelog** describing
   how it differs from the (frozen) initial plan — scenarios added, removed, or
   changed, and the reason for each.

Do not treat the initial plan as a contract: add tests freely whenever you
identify the need, including mid-implementation. Those additions belong in the
final plan and its changelog. Keeping the initial plan frozen and the final plan
separate is what makes the anticipated-vs-discovered difference visible.

## Done when

- Taxa and edges can be constructed in memory and read back through the §15.2
  endpoints with correct id/name/owner/child/parent data.
- Roots, per-taxon containing-trees, and the `shared` predicate compute
  correctly on multi-tree graphs.
- The invariant module is pure, independently importable, and its evaluation of
  all three §3.3 invariants — including the cross-tree path — matches the spec.