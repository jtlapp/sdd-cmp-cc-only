# Phase 4 — Direct owner actions

**Position:** Depends on Phases 1–3 (middleware, invariant engine, reads).
**Authoritative PRD sections:** §5, §6 (§6.1–§6.4), §7, §11.1, §15.3.
**Source of truth:** `prd.md`. Where this brief restates a requirement, the
PRD's wording governs.

## Goal

Implement the owner-authoritative, non-proposal operations and the global write
serialization. After this phase the server is a complete multi-owner system with
no proposal subsystem.

## In scope

1. **Write serialization (§11.1).** Establish the global serialization of all
   state-mutating operations. Every write in this phase and later runs under it;
   reads need not be synchronized.
2. **Create (§6.1).** `POST /taxa`, per §6.1 and §3.4.
3. **Edit (§6.2).** `PATCH /taxa/{id}`, owner only, per §6.2 — including name
   validation across **every** containing tree and the owner-reassignment
   constraints — via the Phase 3 invariant module.
4. **Edge add/remove (§6.4).** `PUT` / `DELETE /taxa/{parentId}/children/{childId}`,
   parent-owner only. Addition validated against §3.3 in the affected tree(s) via
   the invariant module; removal is detach-only (§7).
5. **Delete — tracked as its own sub-milestone (§6.3, §7).** Implement the
   deletion-region computation and both §6.3 preconditions exactly as §6.3
   defines them. `DELETE /taxa/{id}`, owner only.

Authorization uses the Phase 2 middleware (null-user/unregistered rejected;
non-owner / non-parent-owner actions forbidden per §5/§6).

## Explicitly deferred

- Proposals and review actions (§8–§12) → Phases 5–7. Delete is never proposable
  (§7).

## Testing (per §13)

This phase must ship an automated test suite covering the behavior it
introduces. Per §13, choosing and structuring the specific scenarios is your
responsibility — they are deliberately not enumerated here. Aim for thoroughness
along these dimensions:

- **New behavior** — the success, error, and conflict paths for create, edit,
  edge add/remove, and delete, including boundary conditions where a rule's
  outcome changes. The deletion-region computation and its two preconditions are
  the subtlest behavior here and warrant boundary attention.
- **Interactions with earlier phases** — every write goes through the Phase 2
  authorization gate and the Phase 3 invariant module; exercise these operations
  against multi-owner, multi-tree state rather than in isolation, including how
  one operation's effect is constrained by invariants spanning trees built up by
  prior operations.
- **Failure and invalid states** — the specified behavior when an operation is
  forbidden or would violate an invariant or precondition, not merely that it
  fails.

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

- All §15.3 endpoints behave per §5–§7.
- Every write runs under the §11.1 serialization and every invariant check goes
  through the Phase 3 module.
- Delete's region computation and both §6.3 preconditions behave as specified,
  including the halt-and-detach behavior at other-owned taxa.