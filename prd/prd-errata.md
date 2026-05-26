# PRD errata

Corrections to `prd/prd.md`. Each entry overrides the cited PRD passage
where the two disagree; in every other respect `prd/prd.md` remains
authoritative.

## E1 — §15.5 `POST /changes/{id}/accept-cascade` description

**Issue.** The PRD's §15.5 endpoint description contradicts §12.2.

- §12.2 (authoritative behavior spec) requires the cascade to be
  **atomic**: any constituent acceptance failure rolls back the entire
  cascade to the pre-call state and returns a reason.
- §15.5's bullet currently reads, in part: "each constituent acceptance
  that succeeds is committed independently, and a failure aborts only
  the remaining (not-yet-applied) changes," which describes a
  partial-commit semantic.

**Correction.** The §15.5 bullet for `POST /changes/{id}/accept-cascade`
shall be read as:

> `POST /changes/{id}/accept-cascade` — atomically accept the maximal
> cascade rooted at this queued change; on any failure the entire
> cascade rolls back with a reason (§12.2).

§12.2 remains the authoritative behavioral spec for this endpoint.
