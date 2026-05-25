# Phase 1 — Scaffold, error model, and format validators

**Position:** First phase. No dependencies.
**Authoritative PRD sections:** §2, §3.4, §4 (format rules only), §15.6.
**Source of truth:** `prd.md`. Where this brief restates a requirement, the
PRD's wording governs.

## Goal

Stand up the project skeleton and the cross-cutting pieces that every later
phase reuses: the HTTP/error surface and the two pure format validators. No
domain logic, no persistence of taxa, no business endpoints yet.

## In scope

1. **Stack skeleton (§2).** Project set up on the runtime, language, and HTTP
   layer named in §2, exposing a REST API. A health/version endpoint is enough
   to prove the server boots and routes.
2. **Error model (§15.6).** A single JSON error envelope
   `{ "error": { "code", "message", "details"? } }` and a shared helper for
   emitting it, plus the status mapping in §15.6. Later phases emit errors only
   through this helper.
3. **Taxon-name validator (§3.4).** A pure function implementing the §3.4 name
   rules and the case-insensitive comparison rule.
4. **Username validator (§4).** A pure function implementing the §4 username
   format rules and case-insensitive comparison, surfacing the
   validation-vs-forbidden distinction the PRD draws in §4.
5. **Test runner.** Wire up the automated test harness (§13) so every subsequent
   phase ships tests.
6. **State reset endpoint (§15).** The `POST /reset` operation that restores
   fresh-boot state, exempt from the §4 gate (it must work against an empty
   registry). At this phase there is little to clear; implement it as a true full
   reset so that, as each later phase adds state, that state falls under reset's
   fresh-start guarantee — and confirm so in that phase.

## Explicitly deferred

- The user registry and `X-Username` middleware → Phase 2.
- Any taxon storage, IDs, edges, or reads → Phase 3.
- Write serialization → Phase 4.

## Testing (per §13)

This phase must ship an automated test suite covering the behavior it
introduces. Per §13, choosing and structuring the specific scenarios is your
responsibility — they are deliberately not enumerated here. Aim for thoroughness
along these dimensions:

- **New behavior** — the success and failure paths for everything this phase
  adds (the error envelope/status mapping and both validators), including
  boundary conditions where a rule's outcome changes.
- **Interactions with earlier phases** — n/a for the first phase; design the
  validators and error helper so later phases can exercise them in combination.
- **Failure and invalid states** — the specified behavior when input is rejected,
  not merely that it is rejected.

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

- The server boots and a trivial endpoint responds.
- Errors conform to the §15.6 envelope and code/status mapping.
- Both validators exist as pure, independently importable functions whose
  behavior matches §3.4 and §4, including the case-insensitive comparisons.
- The test runner executes via a single documented command.
- `POST /reset` returns the server to fresh-boot state and is callable without a
  registered user.