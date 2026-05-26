# Phase 7 — Cascade, invalidation, and integration

**Position:** Final phase. Depends on Phases 1–6.
**Authoritative PRD sections:** §11.4, §12.2, §12.4, §13, §14, Appendix A.
Builds on the single review loop from Phase 6.
**Source of truth:** `prd.md`. Where this brief restates a requirement, the
PRD's wording governs.

## Goal

Layer the two most error-prone behaviors in the system onto the Phase 6
baseline — atomic cascade acceptance and the three-mode invalidation model —
then exercise the whole system end to end.

## In scope

1. **Atomic accept-cascade (§12.2).** `POST /changes/{id}/accept-cascade`, per
   §12.2: the maximal recursive set the reviewer can accept within the rooted
   subtree, applied in payload-topological order, bounded by other-owner changes
   and leaves, atomic with full rollback and a reason on any constituent failure.
   Preserve the §12.2 note about standalone-vs-cascade validation non-equivalence.
2. **Invalidation model (§11.4) — all three modes, lazily evaluated.**
   - Case 1 (dependency failure): complete the ancestor-invalid half (the reject
     half was wired in Phase 6).
   - Case 2 (self-invalidation): auto-dismiss per §11.4.
   - Case 3 (external invalidation): mark invalid but keep queued pending
     dismiss, per §11.4.
   - Validity evaluated **lazily** per §11.4; the proposer status view shows only
     `invalid` for all three cases (§11.5).
3. **Dismiss (§12.4).** `POST /changes/{id}/dismiss`, per §12.4 (case-3 only).

## Integration

This phase is also where the system is exercised end to end. Per §13, build the
full happy/edge/failure matrix, using fiction-genre taxa (§13) and treating the
§14 "accepted properties" as intended behavior to verify. Appendix A is
available in the PRD as non-normative illustration of intended behavior.

## Testing (per §13)

This phase must ship an automated test suite covering the behavior it
introduces. Per §13, choosing and structuring the specific scenarios is your
responsibility — they are deliberately not enumerated here. Aim for thoroughness
along these dimensions:

- **New behavior** — cascade acceptance and rollback, each of the three §11.4
  invalidation modes, lazy evaluation, and dismiss, including boundary conditions
  where a rule's outcome changes.
- **Interactions with earlier phases** — this is the integration phase: exercise
  the full lifecycle against the direct actions, ownership, invariants, routing,
  dependencies, and single-review behavior from every prior phase, including how
  actions by one user affect another user's queued or latent changes.
- **Failure and invalid states** — the specified behavior on mid-cascade failure
  and on each route by which a change becomes invalid, including how the proposer
  view and the reviewer queue reflect it.

If, while implementing, you identify cases the spec implies that these
dimensions don't obviously cover, add tests for them.

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

- Accept-cascade is atomic with correct rollback and reasons.
- All three §11.4 invalidation modes behave per spec, lazily evaluated, with
  dismiss handling case 3 only.
- The system passes an end-to-end suite covering the §13 matrix.