# Phase 2 — Final Test Plan

This supersedes `phase-2-initial.md` (frozen). It records what was actually
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

**94 tests total, all passing** (43 inherited from Phase 1; 51 new in Phase 2).

## Resolved spec ambiguities (recorded for traceability)

Carried over from `phase-2-initial.md` (unchanged):

1. **`POST /users` is exempt from the registry gate** for the caller's
   `X-Username` (bootstrap carve-out, parallel to `/reset`'s exemption).
   Format check still applies.
2. **Malformed `X-Username` → `400 validation_error` universally** on every
   non-`/reset` endpoint, including read endpoints.
3. **Response shapes.** `POST /users` → `{username: <canonical>}`;
   `GET /users` → `{users: [<canonical>, …]}`.
4. **Casing.** Registry stores first-registered casing as canonical. Lookups
   are case-insensitive; a case-variant re-registration is a `409 conflict`.

## What is tested

New Phase-2 files (under `test/`, named to mirror the modules they exercise):

- `registry.test.ts` — `POST /users` and `GET /users` end-to-end (success,
  validation, duplicate, caller-X-Username variations, reset).
- `identityMiddleware.test.ts` — both middleware variants
  (`identityWithRegistry`, `identityFormatOnly`) against a stand-in protected
  route mounted inside the test file.
- `requireWriter.test.ts` — the write gate, chained on top of
  `identityWithRegistry`, against a stand-in protected write route.
- `usersIntegration.test.ts` — end-to-end through the real `createApp`,
  combining registration + middleware + reset to verify production wiring.

Phase-1 files are unchanged and still pass.

### 1. `POST /users` (§15.1) — registry.test.ts

Success paths:
- Well-formed name (`"Alice"`) → `201` with `{username: "Alice"}`.
- Internal whitespace allowed (`"Anna Karenina Reader"`).
- Single non-whitespace character (`"a"`).
- Multiple distinct registrations in order, visible on subsequent `GET /users`.

Validation errors (400 `validation_error`):
- Missing `username` field.
- Non-string `username` (null, number, object, array, boolean).
- Empty-string `username`.
- Leading- and trailing-whitespace `username`.
- Whitespace-only `username` (space / tab / newline / multi).
- Malformed JSON body (not parseable).
- Bare JSON value instead of object (`"alice"`, `["alice"]`, `42`, `null`).

Conflict (409):
- Exact-duplicate name.
- Case-variant duplicate (`"Alice"` then `"ALICE"` and `"alice"`, both
  directions). Response carries `details.existing` with the canonical
  registered casing.

Caller-X-Username variations on `POST /users` (decisions #1 + #2):
- No header (null) → 201 (bootstrap).
- Empty header (null) → 201.
- Unregistered well-formed header → 201 (decision #1 carve-out). Verified
  the unregistered caller's name was NOT itself registered as a side effect.
- Registered header → 201.
- Malformed header (NBSP-prefixed; see *Note on testing malformed headers*
  below) → 400 with no side effect: the registry stays empty even though the
  body would have been valid.

### 2. `GET /users` (§15.1) — registry.test.ts

- Empty registry → `200 {users: []}`.
- After registering Alice + Bob (in order) → `{users: ["Alice", "Bob"]}`,
  preserving first-registered casing (decision #4).
- Null caller → 200 (§15.2 read is open to all).
- Registered caller → 200.
- Registered caller with case-variant header (`X-Username: "ALICE"` for
  registered `"Alice"`) → 200.
- Unregistered well-formed caller → 403 `forbidden` (decision #2).
- Malformed caller → 400 `validation_error` (decision #2).

### 3. Reset clears registry (§15) — registry.test.ts

- After registering, `POST /reset` empties the registry; `GET /users` is
  back to `{users: []}`.
- After reset, re-registering the prior name succeeds (no leftover duplicate).
- After reset, the prior `X-Username` is now unregistered → `GET /users`
  with that header → 403.

### 4. Identity middleware (§4) — identityMiddleware.test.ts

Tested against a stand-in protected route (`GET /echo`) that echoes the
resolved identity. Phase 2 ships no production write endpoint, so the
middleware is proved in isolation per the brief.

`identityWithRegistry` (full §4 gate):
- Absent / empty `X-Username` → handler runs, sees `{kind: "null"}`.
- Malformed `X-Username` (each of NBSP-prefixed/-suffixed/-only inputs) →
  400 `validation_error`; handler never invoked.
- Well-formed but unregistered → 403 `forbidden` with message naming the
  unregistered username; handler never invoked.
- Registered, exact-case → handler runs, sees
  `{kind: "registered", username: "Alice"}`.
- Registered, case-variant (`"alice"`, `"ALICE"`, `"AlIcE"`) → handler runs;
  identity always carries the **canonical** form (`"Alice"`).
- Malformed and unregistered both conform to the §15.6 envelope (JSON
  Content-Type, `error.code`, `error.message`).

`identityFormatOnly` (POST /users carve-out):
- Absent header → null identity, handler runs.
- Malformed header STILL 400s — format check is not waived (decision #2).
- Unregistered well-formed header → handler runs, sees null-shaped identity
  (decision #1: caller is allowed through without being in the registry).
- Registered header → handler runs, sees canonical identity.

### 5. Write gate (§4) — requireWriter.test.ts

Tested against a stand-in protected write route (`POST /write`) chained as
`identityWithRegistry → requireWriter → handler`. No production write
endpoint exists in Phase 2; phases 4–7 will mount this chain on real ones.

Core gate behavior:
- Null identity (no header) → 403 with message indicating writes not
  available to anonymous users.
- Null identity (empty header) → 403.
- Registered identity → handler runs and receives the canonical identity.

Short-circuit cases (asserting the layered behavior, not duplicate logic):
- Malformed header short-circuits in the identity layer → 400
  `validation_error` (not 403 from the writer layer).
- Unregistered short-circuits in the identity layer → 403 `forbidden` with
  message naming "unregistered" (distinguishable from null-user wording).
- Registered case-variant header still resolves and the writer accepts → 200.

### 6. Integration through `createApp` (interactions w/ Phase 1) — usersIntegration.test.ts

End-to-end through the real app factory, exercising the real wiring rather
than stand-in routes:

- Two-user registration → list-as-Alice / list-as-null / list-as-Carol(403)
  / list-malformed(400) all in one flow.
- `POST /reset` mid-flow: previously valid `X-Username: Alice` now 403s;
  registry is empty.
- §15.6 envelope codes (400, 403, 404, 409) all surface through the
  Phase-1 `httpError`/envelope helpers from Phase-2 sources.
- `/reset` remains §4-exempt for absent / empty / unregistered / malformed
  callers alike.

## Note on testing malformed `X-Username` headers

HTTP strips Optional Whitespace (OWS — ASCII space and horizontal tab) from
header values per RFC 9110, and `\n` is not even a legal header byte. A test
that sends `X-Username: " alice"` (regular space prefix) over `app.request`
arrives at the server as `"alice"` — a *well-formed* value, not malformed.

To exercise the malformed path through HTTP, tests use **NBSP (` `)** as
the leading/trailing whitespace character. NBSP matches JavaScript's `\s`
class (so `parseUsername` rejects it as malformed) but is not HTTP OWS (so
it survives transit). This is invisible in source — the NBSP is the literal
character, not an escape — but is reliable and is documented inline in the
tests where it appears. The Phase-1 `parseUsername` unit tests continue to
cover the OWS forms directly (no HTTP involved).

## Out of scope (deferred to later phases)

Unchanged from the initial plan: taxon storage / IDs / edges / read endpoints
(`GET /taxa`, `GET /trees`, …) → Phase 3; write endpoints the middleware
will eventually protect → Phases 4–7; write serialization → Phase 4;
proposals / queues / review actions → Phase 4+.

## Changelog vs. `phase-2-initial.md`

The plans match on **scope and behavior** to test. Differences are
implementation-time refinements that emerged once code existed:

- **Added: bare-JSON-value rejection on `POST /users`.** Initial plan covered
  malformed JSON and missing `username` field, but didn't explicitly call
  out a body like `"alice"` or `["alice"]` (valid JSON, wrong shape). The
  final suite asserts these are rejected with 400. **Reason:** the body
  parser is called via `c.req.json()` which succeeds on any valid JSON;
  the route's shape check (`typeof body === "object" && !Array.isArray`) is
  a real branch worth pinning.

- **Added: side-effect-free assertions on the malformed-header failure
  cases.** When `POST /users` is rejected for a malformed `X-Username`, the
  test now also asserts the body's `username` was NOT registered (`GET /users`
  returns `{users: []}` afterwards). **Reason:** the §4 short-circuit must
  happen before the handler runs at all; without this assertion a future
  refactor could silently move the handler's work in front of the gate.

- **Added: distinct-message assertion for unregistered vs. null-user 403.**
  Both produce `forbidden`, but the messages must differ (one mentions
  "unregistered", the other "anonymous/null") so an API consumer can tell
  the two §4 outcomes apart. **Reason:** discovered while writing the
  `requireWriter` chain test — without this, the layered behavior couldn't
  be distinguished from a single combined check.

- **Refined: malformed-header tests use NBSP (` `) instead of OWS.**
  See *Note on testing malformed `X-Username` headers* above. The initial
  plan listed inputs like `" alice"` and `"alice "` (regular space), which
  HTTP normalizes away before the server sees them. **Reason:** discovered
  at first test run — `app.request("/echo", {headers: {"X-Username": " alice"}})`
  was producing 200, not 400. The §4 format rule is enforced by
  `parseUsername` (Phase 1) which is still tested with OWS at the unit
  level; the HTTP-level tests now use NBSP so they actually traverse the
  malformed branch end-to-end.

- **Added: bare-JSON-value rejection at the integration layer.** Mirrors
  the registry-suite addition above; the integration suite confirms the
  same `400` envelope surfaces through `createApp`. **Reason:** coverage
  symmetry between focused and end-to-end suites.

- **Added: `details.existing` assertion on duplicate-registration response.**
  Initial plan said "a reason sufficient to identify the collision," but
  didn't pin the shape. Final tests check both the message contains the
  conflicting name AND `details.existing` carries the canonical casing.
  **Reason:** §15.6 says "the reason accompanies the response" — without a
  structural assertion the contract drifts at the next refactor.

- **Added: 404 round-trip through Phase 1 envelope from a `/users/...`
  subpath.** Mentioned as smoke-only in the initial plan; final suite has
  one explicit `GET /users/nope` test that verifies the Phase-1 envelope is
  still emitted by Phase-2 routing. **Reason:** confirms Phase 2's mount of
  `usersRouter` doesn't shadow the Phase-1 notFound handler.

No scenarios were removed.
