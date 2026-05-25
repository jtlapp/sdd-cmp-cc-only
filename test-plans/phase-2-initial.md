# Phase 2 — Initial Test Plan (FROZEN)

This plan is written from the spec (`prd/prd.md` §2, §4, §15.1, §15.2, §15.6
and `prd/phase-2-users.md`) **before implementation begins**. Once any
implementation code lands, this file is frozen and must not be edited. The
phase's `phase-2-final.md` supersedes it and records what was actually tested,
with a changelog of differences.

## Scope under test

Phase 2 introduces:

- A user **registry** with `POST /users` (register) and `GET /users` (list).
- Request-time **identity resolution** of the `X-Username` header into one of
  four cases: null (anonymous), malformed (validation error), unregistered
  (forbidden), and registered.
- A reusable **authorization middleware** that produces those §4 outcomes for
  protected endpoints, with a **write gate** that additionally rejects null
  users on write endpoints.
- Reset (Phase 1) is extended in spirit: the registry it now owns is cleared
  by `POST /reset` and reset remains §4-exempt.

It does **not** include any taxon storage, edges, reads of taxa, or the actual
write endpoints those identities will eventually gate — those are explicitly
deferred to phases 3+. The middleware must therefore be proved on a stand-in
protected route in tests, since no production write endpoint yet exists.

## Resolved spec ambiguities (decided up front, recorded for traceability)

These were ambiguous when reading PRD §4 / §15.1 together; each is decided
before tests are written and is part of what this plan verifies.

1. **`POST /users` is exempt from the registry gate** for the caller's
   `X-Username` (parallel to `/reset`'s exemption). Without this, no first
   user can ever register. The §4 format check on `X-Username` still applies.
2. **Malformed `X-Username` → `400 validation_error` universally** on every
   non-`/reset` endpoint, including read endpoints, per §4's wording that a
   present-but-malformed header "is rejected as a validation error" (not
   silently treated as null).
3. **Response shapes.** `POST /users` → `{ "username": <canonical-form> }`;
   `GET /users` → `{ "users": [<canonical-forms>] }`. (PRD does not pin shapes;
   wrapped objects chosen so the surface can grow without breakage.)
4. **Casing.** Registry stores the **first-registered casing** and returns it
   as canonical. Lookups (registration duplicate check; X-Username matching)
   are case-insensitive per §4. A later registration of the same name with
   different casing is a `409 conflict`.

## Coverage dimensions (per the brief)

- **New behavior.** Success and failure paths for registration, identity
  resolution, and each middleware outcome, including boundary cases.
- **Interactions with earlier phases.** Exercise registration and identity
  through the Phase 1 `parseUsername` validator and §15.6 error envelope, not
  in isolation.
- **Failure and invalid states.** The *specified* behavior for each rejected
  case (malformed, unregistered, null-user write), not merely that it is
  rejected.

## Test groups

### 1. Registry — `POST /users` (§15.1)

Successful registration:
- A well-formed name (e.g. `"Alice"`) → `201` with `{username: "Alice"}`.
- Internal whitespace allowed: `"Anna Karenina Reader"` → `201`.
- A single non-whitespace character: `"a"` → `201`.
- Multiple distinct registrations succeed, and order is observable on `GET /users`.

Malformed body / validation errors (`400 validation_error` envelope):
- Missing `username` field.
- `username: null`, `username: 123`, `username: { … }`, `username: []` (non-string).
- Empty string `username: ""`.
- Leading whitespace `" alice"`.
- Trailing whitespace `"alice "`.
- Whitespace-only (`" "`, `"\t"`, `"\n"`).
- Malformed request body (not valid JSON; missing/wrong Content-Type).

Duplicate registration / conflict (`409 conflict` envelope):
- Re-registering the exact same name (`"Alice"` twice) → second is 409.
- Re-registering with different casing (`"Alice"` then `"ALICE"` or `"alice"`)
  → second is 409 (case-insensitive match per §4).
- The duplicate-conflict response carries the §15.6 envelope with a reason
  sufficient to identify the collision.

`X-Username` on the *caller*:
- Caller with **no** `X-Username` (null user) can register a new name → `201`.
  This is required for bootstrapping the first user.
- Caller with a **registered** `X-Username` can also register a different
  name → `201`.
- Caller with an **unregistered** non-null `X-Username` can still register a
  new name → `201` (Phase 2 decision #1 — registry-gate carve-out).
- Caller with a **malformed** `X-Username` → `400 validation_error`, even
  though the body would otherwise have been valid (decision #2).

### 2. Registry — `GET /users` (§15.1)

- Empty registry → `200` with `{users: []}`.
- After registering Alice and Bob in that order → `{users: ["Alice", "Bob"]}`
  (canonical form preserved per decision #4).
- Available to the **null user** (no `X-Username` header) → `200`, since §15.2
  reads are available to all.
- Available to a **registered** caller → `200`.
- Caller with an **unregistered** non-null `X-Username` → `403 forbidden`
  (registry gate applies on read endpoints other than `POST /users` and
  `/reset`).
- Caller with a **malformed** `X-Username` → `400 validation_error`.

### 3. Identity resolution & authorization middleware (§4)

The middleware applies to every non-`/reset` endpoint and produces one of
four outcomes from the `X-Username` header:

| Header value           | Outcome                                  |
|------------------------|------------------------------------------|
| absent / empty         | null identity                            |
| malformed              | `400 validation_error`, no handler runs  |
| non-null, unregistered | `403 forbidden`, no handler runs         |
| non-null, registered   | registered identity, handler runs        |

Tested directly against a stand-in protected route mounted only inside the
tests (because no production write endpoint exists yet):

- **Malformed header** with each of the §4 malformed shapes
  (`" alice"`, `"alice "`, `"   "`, `"\t"`, `"\nalice"`) → `400`, envelope
  with `code: "validation_error"`. Handler is never invoked.
- **Unregistered well-formed header** → `403`, envelope with
  `code: "forbidden"`, message indicating the name is unregistered. Handler
  is never invoked.
- **Null (absent) header** → handler runs and observes a null identity.
- **Null (empty-string) header** → same as absent.
- **Registered header**, exact-case → handler runs and observes the
  registered identity with the canonical name.
- **Registered header, case variant** (`X-Username: "ALICE"` when Alice
  registered as `"Alice"`) → handler runs; the identity passed downstream
  carries the **canonical** form (`"Alice"`), per decision #4.
- The four error responses all conform to the §15.6 envelope.

### 4. Write gate (§4, "Null user may perform read operations only")

Layered on top of identity resolution. Tested against a stand-in protected
write route:

- Null identity → `403 forbidden`, envelope reason indicating writes are not
  available to anonymous users. Handler never runs.
- Registered identity → handler runs.
- (Malformed and unregistered already short-circuit in the identity layer
  before the write gate is reached — the gate need not duplicate those
  rejections, but the chained behavior is asserted end-to-end.)

### 5. Reset (§15) — extended for the new state

Phase 1 established the reset seam; Phase 2 adds registry state to clear.

- `POST /reset` continues to return `204` and is callable by null,
  unregistered, and malformed-header callers (§4 exemption preserved — note
  the malformed-header exemption is unique to reset, in contrast to every
  other endpoint per decision #2).
- After registering Alice + Bob, calling `POST /reset` empties the registry:
  `GET /users` returns `{users: []}`; re-registering `"Alice"` after reset
  succeeds (no leftover duplicate).
- After reset, a previously-registered `X-Username` (e.g. `"Alice"`) on a
  protected route is treated as **unregistered** → `403`.

### 6. Interactions with Phase 1

Not new modules, but the integration points must be verified:

- Identity resolution dispatches to the Phase 1 `parseUsername` and treats
  its `null` / `valid` / `malformed` outputs as specified above (not
  reinventing format rules).
- All four §15.6 codes used by Phase 2 (`validation_error`, `forbidden`,
  `not_found`, `conflict`) round-trip through the Phase 1 `httpError` /
  envelope helpers — i.e. the error bodies look identical to Phase 1's tests
  for those codes.
- `GET /users/{nope}` — there is no such route; Phase 1's 404-with-envelope
  fallback still applies (smoke-checked, not duplicated here).

## Out of scope (deferred to later phases)

- Taxon storage, IDs, edges, and reads (`GET /taxa`, `GET /trees`, …) → Phase 3.
- Write endpoints the middleware will eventually protect (`POST /taxa`,
  `PATCH /taxa/{id}`, …) → Phases 4–7.
- Write serialization (§11.1) → Phase 4.
- Proposals, queues, review actions → Phase 4+.

## Notes on test mechanics (per the toolchain supplement)

- Tests use `node:test` and `node:assert/strict`; no third-party framework.
- Tests live under `test/`, are named `*.test.ts`, are compiled by `tsc`,
  and run via `node --test "dist/**/*.test.js"`.
- Phase-2 routes are exercised via `app.request(...)` against an in-process
  Hono app — no port binding.
- Tests that exercise registry state call `POST /reset` first, per the
  toolchain supplement's isolation rule and §15. Pure unit tests on the
  registry data structure (if any) reset their own state directly.
- The stand-in protected route used to prove the middleware in isolation is
  mounted inside the test file (a tiny Hono app), not the production
  `createApp` — Phase 2 ships no production write endpoint.
