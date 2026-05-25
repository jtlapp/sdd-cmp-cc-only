# Phase 1 — Initial Test Plan (FROZEN)

This plan is written from the spec (`prd/prd.md` §2, §3.4, §4, §15.6 and
`prd/phase-1-scaffold.md`) **before implementation begins**. Once any
implementation code lands, this file is frozen and must not be edited. The
phase's `phase-1-final.md` supersedes it and records what was actually tested,
with a changelog of differences.

## Scope under test

Phase 1 introduces:

- A booting REST server (health/version endpoint).
- A single JSON error envelope and a shared helper (§15.6).
- A pure taxon-name validator (§3.4), including case-insensitive comparison.
- A pure username validator (§4), surfacing the validation-vs-forbidden
  distinction, including case-insensitive comparison.
- A `POST /reset` endpoint that restores fresh-boot state, exempt from §4.

It does **not** include any taxon storage, user registry, proposal mechanism,
or `X-Username` enforcement middleware (those are explicitly deferred to phases
2–4).

## Coverage dimensions (per the brief)

- **New behavior.** Success and failure paths for everything Phase 1 adds.
- **Interactions with earlier phases.** N/A — first phase.
- **Failure and invalid states.** The specified behavior when input is rejected,
  not merely that it is rejected.

## Test groups

### 1. Taxon-name validator (§3.4)

A pure function with no I/O.

Valid inputs (must be accepted):
- a single non-whitespace character (`"a"`).
- a multi-word name with internal whitespace (`"Epic Fantasy"`).
- a name with internal newlines or tabs (internal whitespace is unrestricted).
- a name whose only "non-letter" content is punctuation (e.g.
  `"Sword-and-Sorcery"`).
- a single-character name that is a digit or punctuation (the rule is on
  whitespace, not alphabetic content).

Invalid inputs (must be rejected as a validation error):
- the empty string `""`.
- a string consisting only of whitespace (`" "`, `"\t"`, `"\n"`, `"   "`).
- a leading space (`" Fantasy"`).
- a trailing space (`"Fantasy "`).
- leading or trailing tab/newline (boundary characters other than the ASCII
  space).
- both leading and trailing whitespace (`" Fantasy "`).

Case-insensitive equality (the §3.4 comparison rule):
- `"Fantasy"` equals `"fantasy"`.
- `"FANTASY"` equals `"FaNtAsY"`.
- `"Fantasy"` does **not** equal `"Fantasies"`.
- whitespace inside a name is significant for equality (the rule is
  case-insensitive, not whitespace-insensitive): `"Epic Fantasy"` does **not**
  equal `"Epicfantasy"`.

The validator itself does no comparison — equality is exposed as its own
helper. Both must be importable without pulling in the HTTP layer.

### 2. Username validator (§4)

A pure function that classifies a request's `X-Username` header value into one
of three buckets — the validation-vs-forbidden distinction the PRD draws:

- **null user** — header absent or empty string. Not forbidden by validation;
  whether a write is then forbidden is a separate concern (deferred to phase 2).
- **valid** — non-empty string with no leading/trailing whitespace.
- **malformed** — present but whitespace-only, or with leading/trailing
  whitespace. Phase 1 does not turn this into an HTTP status by itself; it
  exposes the distinction so callers can map to 400 per §15.6.

Inputs (must classify correctly):
- `undefined` → null user.
- `""` → null user.
- `"alice"` → valid.
- `"Alice With Spaces Inside"` → valid (internal whitespace OK).
- `" alice"` → malformed (leading space).
- `"alice "` → malformed (trailing space).
- `" alice "` → malformed.
- `"   "` → malformed (whitespace-only is not the null user).
- `"\talice"` / `"alice\n"` → malformed.

Case-insensitive equality (§4 rule):
- `"alice"` equals `"ALICE"` equals `"Alice"`.
- `"alice"` does not equal `"alicia"`.

The validator must not consult any registry (registry is phase 2). The "is this
user registered" check that yields 403 is explicitly out of scope.

### 3. Error model (§15.6)

The shared helper produces a JSON body of the form
`{ "error": { "code", "message", "details"? } }` with the correct HTTP status
per the §15.6 mapping.

Status mapping (each verified):
- `validation_error` → `400`.
- `forbidden` → `403`.
- `not_found` → `404`.
- `conflict` → `409`.

Envelope shape:
- The body always contains `error.code` and `error.message`.
- `error.details` is included when supplied, omitted when not.
- The response `Content-Type` is JSON.

These behaviors are tested by invoking the helper directly (or by hitting
endpoints engineered to produce each code) — not by asserting on Hono internals.

### 4. Routing and boot

- `GET /health` returns `200` with a small JSON body indicating the server is
  up. This proves boot + routing per the brief.
- An unknown path (e.g. `GET /nope`) returns `404` and the §15.6 error
  envelope, not Hono's default text.
- An unsupported method on a known path returns an error envelope (the exact
  status — 404 vs 405 — depends on Hono's routing; the assertion is that the
  body conforms to §15.6, never raw HTML/text).

### 5. `POST /reset` (§15, brief item 6)

- Returns `204 No Content` with an empty body on success.
- Is callable with **no** `X-Username` header (null user).
- Is callable with an **unregistered** `X-Username` (any non-empty string —
  registry doesn't exist yet, and reset is exempt from the §4 gate regardless).
- Is callable with a **malformed** `X-Username` (e.g. `" alice"`) — reset's §4
  exemption covers the malformed case too, per the brief's wording that reset
  "must work against an empty registry."
- Other methods on `/reset` (e.g. `GET /reset`) return an error envelope, not
  HTML.
- Calling reset twice in a row is idempotent (both succeed; second is a no-op).

Phase 1 has no domain state to clear, so there is no "state cleared" assertion
yet — that obligation moves with the state into phases 2+. The structural
requirement here is just that the endpoint exists, returns 204, and is
unconditionally callable.

## Out of scope (deferred)

- User registry / `POST /users` / `GET /users` (phase 2).
- `X-Username` enforcement middleware that returns 403 for unregistered users
  or null-user writes (phase 2).
- Taxon CRUD, edges, trees, IDs (phase 3).
- Proposals, routing, queues, review actions (phase 4+).

## Notes on test mechanics (per the toolchain supplement)

- Tests use `node:test` and `node:assert/strict`; no third-party framework.
- Tests live under `test/`, are named `*.test.ts`, are compiled by `tsc`, and
  run via `node --test "dist/**/*.test.js"`.
- The Phase 1 routes are tested via `app.request(...)` on the Hono app
  instance — no port binding, no fetch against a live server.
- Tests that touch the running server's state must call `POST /reset` first.
  Phase 1's tests touch no domain state, but the test for `POST /reset` itself
  is intentionally written to be order-independent.
