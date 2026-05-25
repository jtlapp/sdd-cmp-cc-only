# Phase 1 — Final Test Plan

This supersedes `phase-1-initial.md` (frozen). It records what was actually
tested, with a changelog of how it differs from the frozen initial plan and the
reason for each change.

## Run command

```
npm test                 # tsc && node --test "dist/**/*.test.js"
```

Or, equivalently:

```
npx tsc
node --test "dist/**/*.test.js"
```

43 tests, all passing.

## What is tested

Files (under `test/`, mirroring `src/` layout):

- `taxonName.test.ts` — §3.4 name rules + case-insensitive equality.
- `username.test.ts` — §4 header parser (null/valid/malformed) +
  case-insensitive equality.
- `errors.test.ts` — §15.6 envelope, status mapping, `httpError` helper, and
  `ApiError` class.
- `app.test.ts` — `GET /health`, `POST /reset` (incl. §4-exempt cases),
  unknown-route 404 envelope, unsupported-method behavior, and the central
  `registerReset` seam.

### 1. Taxon-name validator (§3.4)

- Accepts: single non-whitespace character; multi-word names with internal
  whitespace (spaces, tabs, newlines); hyphenated names; single-character
  digits and punctuation.
- Rejects: empty string; whitespace-only strings (space, tab, newline, multi);
  leading whitespace; trailing whitespace; leading/trailing tab and newline;
  both-side whitespace; non-string inputs (null, undefined, number, object,
  array).
- Equality: case-insensitive (`"Fantasy" == "fantasy"`, `"FANTASY" == "FaNtAsY"`);
  distinct strings unequal; internal whitespace is significant
  (`"Epic Fantasy" != "Epicfantasy"`).

### 2. Username header parser (§4)

- Null user: `undefined`, `null`, and the empty string all → `{ kind: "null" }`.
- Valid: well-formed names (`"alice"`, `"Alice With Spaces Inside"`).
- Malformed: leading space, trailing space, both-side whitespace, whitespace-only
  (incl. tabs/newlines) — explicitly NOT silently treated as the null user, per
  §4.
- Equality: case-insensitive; distinct strings unequal.

### 3. Error model (§15.6)

- `STATUS_BY_CODE` mapping is exact: `validation_error→400`, `forbidden→403`,
  `not_found→404`, `conflict→409`.
- `errorBody`: envelope shape with and without `details`; `details` omitted
  (key absent) when not supplied, not present as `null`.
- `httpError`: each of the four codes returns its mapped HTTP status with the
  envelope and `application/json` Content-Type; `details` is passed through.
- `ApiError` class: carries `code`, `message`, `details`; subclasses `Error`.

### 4. App routing and boot

- `GET /health` → `200` with `{ status: "ok" }` and JSON Content-Type — proves
  boot + routing.
- Unknown path → `404` with the §15.6 envelope (`code: "not_found"`,
  message names the method and path), not Hono's default text.
- Unsupported method on a known path → some non-200 status with a JSON
  envelope whose `code` is one of the four documented §15.6 codes (the brief
  is about the body shape; Hono treats this as `not_found`).

### 5. `POST /reset` (§15)

- Returns `204 No Content` with an empty body.
- Callable with no `X-Username` header (null user).
- Callable with a well-formed but **unregistered** `X-Username`.
- Callable with a **malformed** `X-Username` (e.g. `" alice"`) — confirming
  reset's §4 exemption covers the malformed case.
- Callable with an empty `X-Username`.
- Idempotent — two calls in a row both return 204.
- Invokes every callback registered via `registerReset`. Phase 1 has no domain
  state, but this confirms the seam that phases 2+ plug into.

### 6. End-to-end boot smoke (manual)

Ran `PORT=3457 node dist/src/server.js`, hit `/health` → 200 JSON, `POST /reset`
→ 204 empty body, `GET /nope` → 404 envelope. Confirms `@hono/node-server`
binding works alongside the in-process `app.request(...)` tests.

## Out of scope (deferred)

Unchanged from the initial plan: user registry, `X-Username` enforcement
middleware, taxon CRUD/edges/trees/IDs, proposals/queues/review actions.

## Changelog vs. `phase-1-initial.md`

The plans match on **scope and behavior** to test. The differences are
mechanical/implementation choices that emerged once code existed:

- **Added: non-string inputs for `validateTaxonName`.** The validator accepts
  `unknown`, so I added a test pinning the rejection of `null`, `undefined`,
  `number`, `{}`, `[]`. The initial plan only listed string-shaped invalid
  inputs. Reason: PRD §3.4 calls out "must be a non-empty string" — the
  non-string boundary needed coverage to keep the validator honest as later
  phases call it from JSON payload parsing.
- **Added: `registerReset` callback test.** Verifies that callbacks registered
  via the central `state.registerReset` seam are invoked by `POST /reset`.
  Reason: the brief requires reset to be a true full reset so later phases
  fall under the fresh-start guarantee; without this test the seam is
  unverified and a phase-2 author could plug into it incorrectly without a
  failure surfacing here.
- **Refined: unsupported-method behavior.** The initial plan said the response
  shape should conform to §15.6, leaving the status open. The final test asserts
  on the body shape (an envelope with one of the four documented codes) and
  records that under Hono this manifests as `404 not_found` rather than `405`.
  Reason: Hono's router is path-only, so this is a routing artifact, not a
  domain decision; the test pins the behavior without overreaching.
- **Renamed: `routes.test.ts` → `app.test.ts`.** Cosmetic; matches the source
  module (`src/app.ts`) it exercises.
- **Confirmed without separate test: "Phase 1 has no domain state to clear."**
  The initial plan noted this; no additional test is needed because there is
  literally no state to assert against. The `registerReset` test above is the
  structural proxy.

No scenarios were removed.
