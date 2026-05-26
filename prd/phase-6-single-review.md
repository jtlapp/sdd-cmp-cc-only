# Phase 6 — Single review loop

**Position:** Depends on Phases 1–5.
**Authoritative PRD sections:** §11.2, §11.3 (promotion), §12.1, §12.3, plus the
acceptance-time validation scope from §10.3 and the ownership rule from §5/§12.1.
**Source of truth:** `prd.md`. Where this brief restates a requirement, the
PRD's wording governs.

## Goal

Land a working **single-decision** review loop on top of Phase 5's routed
changes: accept one change, reject one change, promote dependents, and transfer
ownership when a create is accepted. This establishes a stable baseline before
the cascade/invalidation behavior in Phase 7.

## In scope

1. **Change states (§11.2).** The observable lifecycle vocabulary for this and
   the next phase.
2. **Accept single (§12.1).** `POST /changes/{id}/accept`, reviewer-only, on a
   change currently queued to them. Validate against current live state at the
   scope §10.3 requires, reusing the Phase 3 invariant module; if valid, apply
   atomically and set `accepted`.
3. **Promotion (§11.3).** Accepting an `add`/graft change promotes its direct
   dependents from latent to queued, per §11.3.
4. **Ownership transfer on create-accept (§12.1, §5).** Accepting an `add`-create
   change makes the accepting reviewer the owner of the new taxon.
5. **Reject (§12.3).** `POST /changes/{id}/reject`, reviewer-only; sets
   `rejected` and propagates to payload descendants per §12.3 / §11.4 case 1.

Authorization: review actions require the change's reviewer (§15.5) via the
Phase 2 middleware.

## Explicitly deferred to Phase 7

- Atomic accept-cascade with rollback (§12.2).
- Self-invalidation auto-dismiss (§11.4 case 2), external invalidation that stays
  queued pending dismiss (§11.4 case 3), lazy validity evaluation, and
  `POST /changes/{id}/dismiss` (§12.4).
- An acceptance that fails validation here simply fails with a reason (§12.1);
  full case-2/case-3 handling lands next phase.

## Testing (per §13)

This phase must ship an automated test suite covering the behavior it
introduces. Per §13, choosing and structuring the specific scenarios is your
responsibility — they are deliberately not enumerated here. Aim for thoroughness
along these dimensions:

- **New behavior** — accept-single, reject, promotion on acceptance, and
  create-ownership transfer, including boundary conditions where a rule's outcome
  changes and where acceptance-time validation (§10.3) does or does not hold.
- **Interactions with earlier phases** — acceptance applies real mutations and so
  interacts with the direct actions, ownership, and invariants from Phases 3–4
  and the routing/dependency state from Phase 5; exercise the loop against
  multi-owner, multi-tree state rather than single isolated changes.
- **Failure and invalid states** — the specified behavior when a queued change no
  longer validates at acceptance, and the descendant propagation on reject.

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

- Single accept and reject work end to end with correct promotion and create
  ownership transfer, and acceptance validates at the §10.3 scope via the
  Phase 3 invariant module.