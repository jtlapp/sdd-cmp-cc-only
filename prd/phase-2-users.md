# Phase 2 — Users, identity, and the registry

**Position:** Depends on Phase 1 (error model + username validator + test runner).
**Authoritative PRD sections:** §4, §15.1, plus the null-user/registration rules
referenced in §2 and §4.
**Source of truth:** `prd.md`. Where this brief restates a requirement, the
PRD's wording governs.

## Goal

Implement user identity end to end: the registry, the parsing of `X-Username`
into the null/registered/malformed cases, and the request middleware that gates
every later write.

## In scope

1. **Registry (§15.1).** `POST /users` and `GET /users`, behaving per §15.1
   (including the duplicate and malformed cases). Registration is open — no
   authentication (§2, §4).
2. **`X-Username` parsing (§4).** Resolve each incoming request to the
   null/anonymous, malformed, or registered case per §4, applying the format and
   case-insensitive rules and checking against the registry.
3. **Authorization middleware (§4, §15.6).** A reusable gate, applied by later
   phases to write endpoints, that produces the §4 outcomes for malformed,
   unregistered, null-user-write, and registered callers. Reads remain available
   to all users including null (§4, §15.2).

## Explicitly deferred

- The taxa, edges, and read endpoints the middleware will eventually protect →
  Phase 3.
- The specific write endpoints themselves → Phases 4–7. This phase delivers the
  gate and proves it in isolation.

## Testing (per §13)

This phase must ship an automated test suite covering the behavior it
introduces. Per §13, choosing and structuring the specific scenarios is your
responsibility — they are deliberately not enumerated here. Aim for thoroughness
along these dimensions:

- **New behavior** — the success and failure paths for registration, identity
  resolution, and each middleware outcome, including boundary conditions where a
  rule's outcome changes.
- **Interactions with earlier phases** — exercise registration and identity
  resolution against the Phase 1 validators and error envelope, not in isolation.
- **Failure and invalid states** — the specified behavior for each rejected case
  (malformed, unregistered, null-user write), not merely that it is rejected.

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

- `POST /users` and `GET /users` behave per §15.1.
- Request resolution distinguishes the null, malformed, and registered cases
  exactly as §4 describes.
- The middleware is reusable and produces each §4 gate outcome on a protected
  route.