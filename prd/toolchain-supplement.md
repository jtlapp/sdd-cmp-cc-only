# Supplement — toolchain and test conventions

This file is **incorporated into the PRD by reference** and is binding on every
implementation. It fixes the runtime toolchain, the TypeScript configuration,
and the test mechanics so that all harness projects are built and tested the
same way. It governs **toolchain and testing only** and makes no statement about
domain behavior; where the PRD specifies behavior, the PRD governs.

## Build and run model

- TypeScript is **compiled to JavaScript ahead of time** with `tsc`; the
  compiled output is what runs. Node never executes `.ts` directly — no
  type-stripping, no `ts-node`/`tsx`/`esbuild`.
- Compilation **typechecks and emits in one step**. The shared `tsconfig.json`
  sets `noEmitOnError`, so any type error fails the build and produces no output.
  **Running anything therefore requires a clean typecheck** — there is no way to
  run code that does not typecheck.

## Runtime

- Target runtime: **Node.js 24** (current LTS line). Implementations must build
  and run on this version.
- Because code is compiled, the full TypeScript language is available; there is
  no erasable-syntax restriction.

## Module system and layout

- Each project's `package.json` must declare **`"type": "module"`** (ESM).
- Project layout is fixed so the shared config and commands work uniformly:
  - sources under **`src/`**
  - tests under **`test/`**
  - compiled output under **`dist/`** (produced by the build)
- Under NodeNext ESM, **relative imports in source use the `.js` extension** —
  the compiled target — even though the source file is `.ts`, e.g.
  `import { x } from "./foo.js"`. This is the standard NodeNext rule, not a typo.
- Do not rely on `tsconfig` path aliases at runtime: Node resolves the emitted
  JS with its own resolver and ignores `tsconfig`, so aliases not backed by a
  real runtime resolver will compile but fail to run.

## TypeScript configuration

- All projects use the **identical `tsconfig.json`** distributed alongside this
  file. Do not modify it per project.
- Required dev dependencies: **`typescript`** (current 5.x) and **`@types/node`**
  matching the Node 24 line.

## Build / typecheck gate

```
npx tsc
```

This both typechecks and emits to `dist/`. A type error fails the command and
emits nothing; a phase is neither runnable nor complete unless this succeeds.

## Test framework and execution

- Tests use the **built-in Node test runner** (`node:test`) with
  **`node:assert/strict`**. **No third-party test framework** (no Jest, Vitest,
  Mocha, etc.) and no third-party assertion or mocking libraries.
- Tests are written in TypeScript under `test/`, named `*.test.ts`, compiled by
  the build, and run from the compiled output:

```
node --test "dist/**/*.test.js"
```

- Rationale: uniformity across harnesses — zero test dependencies, no
  framework/version variance, and no install step that can itself fail.

## Test isolation

Any test that exercises server state must call the reset endpoint (PRD §15)
**before** it runs, so no state leaks between tests — e.g. wired into a per-test
`beforeEach`/setup. Such tests must assume an empty registry and empty graph at
start, register the users they need, and must not assume specific server-assigned
IDs (implementation-defined, §2). Pure unit tests that touch no server state need
not reset.

## Per-phase obligations (restating, not replacing, the briefs)

- Every phase still ships its automated test suite per §13 of the PRD and the
  Testing section of that phase's brief, including the frozen initial test plan
  and the final test plan with changelog described there.
- "Phase complete" requires the build (`npx tsc`) to succeed — which includes a
  clean typecheck of both sources and tests — **and** the phase's tests to pass
  under `node --test`.

## One-time validation (recommended)

Before standardizing across harnesses, smoke-test this toolchain on a trivial
project: a minimal `src/index.ts`, a minimal `test/smoke.test.ts`, a
`package.json` with `"type": "module"`, and the distributed `tsconfig.json`.
Confirm that `npx tsc` typechecks and emits to `dist/`, that a deliberate type
error makes `npx tsc` fail with no emit, and that
`node --test "dist/**/*.test.js"` runs the compiled test.