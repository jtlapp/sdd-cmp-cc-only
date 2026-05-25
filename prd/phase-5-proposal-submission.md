# Phase 5 — Proposal submission, routing, and initial disposition

**Position:** Depends on Phases 1–4.
**Authoritative PRD sections:** §8, §9 (§9.1–§9.4), §10 (§10.1–§10.3),
§11.3 (initial disposition only), §11.5, §15.4, plus `GET /proposals*` and
`GET /queue` from §15.2.
**Source of truth:** `prd.md`. Where this brief restates a requirement, the
PRD's wording governs.

## Goal

Accept proposals, fan them out into individually-routed changes, classify
dependencies, and compute each change's **initial** state — before any review
decision exists. The phase stops short of accept/reject.

## In scope

1. **Payload model (§9).** Parse `{ targetRootId, topTaxonId, payload }` and the
   payload-tree of annotated taxa; implement the four ops with the field rules
   (§9.1), top-taxon constraints (§9.2), create-vs-graft semantics (§9.3), and
   the partial-payload rule.
2. **Change derivation + routing (§10.1).** Turn each operative payload taxon
   into a change routed to the single reviewer §10.1 specifies.
3. **Dependency classification (§10.2).** Classify path ancestors as decision vs.
   existence dependencies; record validation scope per §10.3 for later phases.
4. **Initial disposition (§11.3).** Compute each change's submission-time state
   (`queued` vs. `latent`) per §11.3. No promotion happens yet.
5. **Surfaces.** `POST /proposals` (§15.4); `GET /proposals/{id}` and
   `GET /proposals` (§15.2, the §11.5 isomorphic status view); `GET /queue`
   (§15.2). Proposer must be a registered non-null user via the Phase 2
   middleware.

## Explicitly deferred

- All review actions and resulting promotion / invalidation / ownership-transfer
  behavior → Phases 6–7. Latent changes simply stay latent here.

## Testing (per §13)

This phase must ship an automated test suite covering the behavior it
introduces. Per §13, choosing and structuring the specific scenarios is your
responsibility — they are deliberately not enumerated here. Aim for thoroughness
along these dimensions:

- **New behavior** — payload parsing and validation, per-op routing, dependency
  classification, and initial latent/queued disposition, including boundary
  conditions where a rule's outcome changes (e.g. where ops nested under a taxon
  route differently than the taxon itself).
- **Interactions with earlier phases** — proposals are submitted against the
  multi-owner, multi-tree state produced by earlier phases and routed by the
  ownership established there; exercise routing and disposition against such
  state, and through the Phase 2 proposer gate.
- **Failure and invalid states** — the specified behavior for malformed payloads
  and for top-taxon / payload constraints that do not hold.

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

- A submitted proposal fans out into correctly routed changes with correct
  initial latent/queued states, observable via the §11.5 status view and
  `GET /queue`, with no decision having been made.