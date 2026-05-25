# Project: Collaborative Taxon Tree Server

## Source of truth
- `prd/prd.md` is the authoritative specification. `prd/toolchain-supplement.md` is
  incorporated by reference and equally binding: it governs toolchain and test mechanics
  (runtime, module system, build, test framework); `prd/prd.md` governs domain behavior.
- `prd/phase-N-*.md` scope the work into sequential phases. Where a brief restates a
  requirement, the PRD's wording governs. Build only the current phase's scope; respect
  each brief's "explicitly deferred" list.
- `prd/sample-taxonomy.md` is non-normative test data (fiction-genre names) — a naming
  resource for tests, not a requirements input.

## How we work
- Work one phase at a time. Before coding a phase, read its brief and the PRD sections
  it cites, and state a brief plan. If something in the spec is unclear or you'd have to
  decide it yourself, say so rather than silently choosing.

## Testing
- Each phase ships an automated test suite for the behavior it introduces, run by the
  single documented command from the toolchain supplement.
- Two test-plan artifacts per phase: `test-plans/phase-N-initial.md` (written from the
  spec before implementation, then frozen — never edited after its commit) and
  `test-plans/phase-N-final.md` (what was actually tested, with a changelog of how it
  differs). Add tests freely as you discover needs; those additions belong in the final
  plan, not the frozen initial one.
- Treat the PRD's §14 "accepted properties" as intended behavior to verify.

## State reset
- `POST /reset` restores fresh-boot state and is callable without a registered user.
  Every phase that adds state confirms `reset` clears that state.
