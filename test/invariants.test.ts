// PRD §3.3 — the invariant module, the keystone of Phase 3.
//
// Exercises each of the three invariants in isolation (pass + fail) plus
// the combined evaluateAll and its violation shape. Pure unit tests; no
// HTTP, no Phase-4 mutation API. Graphs are constructed via the fixture
// primitives (which do NOT enforce invariants — that's the whole point).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  attachChildFixture,
  clear,
  createTaxonFixture,
  getState,
} from "../src/taxa.js";
import {
  checkNoCycles,
  checkPerTreeNameUniqueness,
  checkPerTreeUniqueOccurrence,
  evaluateAll,
  type Violation,
} from "../src/invariants.js";

function fresh() {
  clear();
}

// --- invariant 1: no cycles ------------------------------------------------

test("invariant 1: a linear chain has no cycles", () => {
  fresh();
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  const c = createTaxonFixture("C", "u");
  attachChildFixture(a.id, b.id);
  attachChildFixture(b.id, c.id);
  assert.deepEqual(checkNoCycles(getState()), []);
});

test("invariant 1: a cross-tree diamond has no cycle", () => {
  fresh();
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  const c = createTaxonFixture("C", "u");
  attachChildFixture(a.id, c.id);
  attachChildFixture(b.id, c.id);
  assert.deepEqual(checkNoCycles(getState()), []);
});

test("invariant 1: a self-edge A→A is a cycle that names A", () => {
  fresh();
  const a = createTaxonFixture("A", "u");
  attachChildFixture(a.id, a.id);
  const violations = checkNoCycles(getState());
  assert.equal(violations.length, 1);
  const v = violations[0]!;
  assert.equal(v.kind, "cycle");
  assert.ok(v.kind === "cycle");
  assert.deepEqual(v.taxa, [a.id]);
});

test("invariant 1: a two-cycle A→B→A reports both taxa", () => {
  fresh();
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  attachChildFixture(a.id, b.id);
  attachChildFixture(b.id, a.id);
  const violations = checkNoCycles(getState());
  assert.equal(violations.length, 1);
  const v = violations[0]!;
  assert.equal(v.kind, "cycle");
  assert.ok(v.kind === "cycle");
  assert.deepEqual([...v.taxa].sort(), [a.id, b.id].sort());
});

test("invariant 1: a three-cycle reachable from a root chain is reported as a cycle", () => {
  // R → A → B → C → A. Cycle (A, B, C). R is the entry but not in the cycle.
  fresh();
  const r = createTaxonFixture("R", "u");
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  const c = createTaxonFixture("C", "u");
  attachChildFixture(r.id, a.id);
  attachChildFixture(a.id, b.id);
  attachChildFixture(b.id, c.id);
  attachChildFixture(c.id, a.id);
  const violations = checkNoCycles(getState());
  assert.equal(violations.length, 1);
  const v = violations[0]!;
  assert.ok(v.kind === "cycle");
  assert.deepEqual([...v.taxa].sort(), [a.id, b.id, c.id].sort());
});

test("invariant 1: a cyclic graph does NOT cause invariant 2 or 3 to also fire spuriously", () => {
  // A self-edge or 2-cycle is purely a cycle; no name collisions, no
  // tree-paths because every taxon has a parent — there are no roots.
  fresh();
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  attachChildFixture(a.id, b.id);
  attachChildFixture(b.id, a.id);
  // No roots → invariant 2 and 3 are vacuous.
  assert.deepEqual(checkPerTreeUniqueOccurrence(getState()), []);
  assert.deepEqual(checkPerTreeNameUniqueness(getState()), []);
});

// --- invariant 2: per-tree uniqueness of occurrence ------------------------

test("invariant 2: a linear chain passes", () => {
  fresh();
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  attachChildFixture(a.id, b.id);
  assert.deepEqual(checkPerTreeUniqueOccurrence(getState()), []);
});

test("invariant 2: a cross-tree diamond passes (diamonds across trees are permitted)", () => {
  fresh();
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  const c = createTaxonFixture("C", "u");
  attachChildFixture(a.id, c.id);
  attachChildFixture(b.id, c.id);
  assert.deepEqual(checkPerTreeUniqueOccurrence(getState()), []);
});

test("invariant 2: an in-tree diamond reports the duplicated taxon with its root", () => {
  fresh();
  const r = createTaxonFixture("R", "u");
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  const x = createTaxonFixture("X", "u");
  attachChildFixture(r.id, a.id);
  attachChildFixture(r.id, b.id);
  attachChildFixture(a.id, x.id);
  attachChildFixture(b.id, x.id);
  const violations = checkPerTreeUniqueOccurrence(getState());
  assert.equal(violations.length, 1);
  const v = violations[0]!;
  assert.ok(v.kind === "in_tree_duplicate");
  assert.equal(v.rootId, r.id);
  assert.equal(v.taxonId, x.id);
});

test("invariant 2: a deeper in-tree diamond is still caught", () => {
  // R → A → B → X, R → C → X (two paths to X, both under root R).
  fresh();
  const r = createTaxonFixture("R", "u");
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  const c = createTaxonFixture("C", "u");
  const x = createTaxonFixture("X", "u");
  attachChildFixture(r.id, a.id);
  attachChildFixture(a.id, b.id);
  attachChildFixture(b.id, x.id);
  attachChildFixture(r.id, c.id);
  attachChildFixture(c.id, x.id);
  const violations = checkPerTreeUniqueOccurrence(getState());
  assert.equal(violations.length, 1);
  assert.ok(violations[0]!.kind === "in_tree_duplicate");
  assert.equal((violations[0] as Extract<Violation, { kind: "in_tree_duplicate" }>).taxonId, x.id);
});

test("invariant 2: shared-across-trees AND duplicated-within-one fires only for the in-tree case", () => {
  // R1 → A, R1 → B, A → X, B → X (in-tree diamond under R1); R2 → X
  // (X is also shared with tree R2). Sharing is fine; the in-tree
  // duplication under R1 is the violation reported.
  fresh();
  const r1 = createTaxonFixture("R1", "u");
  const r2 = createTaxonFixture("R2", "u");
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  const x = createTaxonFixture("X", "u");
  attachChildFixture(r1.id, a.id);
  attachChildFixture(r1.id, b.id);
  attachChildFixture(a.id, x.id);
  attachChildFixture(b.id, x.id);
  attachChildFixture(r2.id, x.id);
  const violations = checkPerTreeUniqueOccurrence(getState());
  // Exactly one violation: the in-tree duplication under R1, not anything
  // about tree R2 (where X appears once).
  assert.equal(violations.length, 1);
  const v = violations[0]!;
  assert.ok(v.kind === "in_tree_duplicate");
  assert.equal(v.rootId, r1.id);
  assert.equal(v.taxonId, x.id);
});

test("invariant 2: two independent in-tree diamonds in different trees both fire", () => {
  fresh();
  // Tree R1: R1 → A1, R1 → B1, A1 → X1, B1 → X1.
  const r1 = createTaxonFixture("R1", "u");
  const a1 = createTaxonFixture("A1", "u");
  const b1 = createTaxonFixture("B1", "u");
  const x1 = createTaxonFixture("X1", "u");
  attachChildFixture(r1.id, a1.id);
  attachChildFixture(r1.id, b1.id);
  attachChildFixture(a1.id, x1.id);
  attachChildFixture(b1.id, x1.id);
  // Tree R2: R2 → A2, R2 → B2, A2 → X2, B2 → X2.
  const r2 = createTaxonFixture("R2", "u");
  const a2 = createTaxonFixture("A2", "u");
  const b2 = createTaxonFixture("B2", "u");
  const x2 = createTaxonFixture("X2", "u");
  attachChildFixture(r2.id, a2.id);
  attachChildFixture(r2.id, b2.id);
  attachChildFixture(a2.id, x2.id);
  attachChildFixture(b2.id, x2.id);
  const violations = checkPerTreeUniqueOccurrence(getState());
  assert.equal(violations.length, 2);
  const byRoot = new Map(
    violations
      .filter((v): v is Extract<Violation, { kind: "in_tree_duplicate" }> => v.kind === "in_tree_duplicate")
      .map((v) => [v.rootId, v.taxonId]),
  );
  assert.equal(byRoot.get(r1.id), x1.id);
  assert.equal(byRoot.get(r2.id), x2.id);
});

// --- invariant 3: per-tree name uniqueness (case-insensitive) --------------

test("invariant 3: a tree with distinct names passes", () => {
  fresh();
  const r = createTaxonFixture("Fiction", "u");
  const a = createTaxonFixture("Fantasy", "u");
  const b = createTaxonFixture("Thriller", "u");
  attachChildFixture(r.id, a.id);
  attachChildFixture(r.id, b.id);
  assert.deepEqual(checkPerTreeNameUniqueness(getState()), []);
});

test("invariant 3: two taxa with the same exact name in the same tree clash", () => {
  fresh();
  const r = createTaxonFixture("Fiction", "u");
  const a = createTaxonFixture("Fantasy", "u");
  const b = createTaxonFixture("Fantasy", "u");
  attachChildFixture(r.id, a.id);
  attachChildFixture(r.id, b.id);
  const violations = checkPerTreeNameUniqueness(getState());
  assert.equal(violations.length, 1);
  const v = violations[0]!;
  assert.ok(v.kind === "name_clash");
  assert.equal(v.rootId, r.id);
  assert.equal(v.name, "fantasy");
  assert.deepEqual([...v.taxa].sort(), [a.id, b.id].sort());
});

test("invariant 3: case-variant names collide (§3.4 case-insensitive)", () => {
  fresh();
  const r = createTaxonFixture("Fiction", "u");
  const a = createTaxonFixture("Fantasy", "u");
  const b = createTaxonFixture("FANTASY", "u");
  attachChildFixture(r.id, a.id);
  attachChildFixture(r.id, b.id);
  const violations = checkPerTreeNameUniqueness(getState());
  assert.equal(violations.length, 1);
  const v = violations[0]!;
  assert.ok(v.kind === "name_clash");
  assert.equal(v.name, "fantasy");
});

test("invariant 3: same name across different trees is fine (per-tree only)", () => {
  // T1: Fiction → Fantasy.  T2: Genres → Fantasy.
  fresh();
  const t1 = createTaxonFixture("Fiction", "u");
  const f1 = createTaxonFixture("Fantasy", "u");
  const t2 = createTaxonFixture("Genres", "u");
  const f2 = createTaxonFixture("Fantasy", "u"); // different taxon, same name
  attachChildFixture(t1.id, f1.id);
  attachChildFixture(t2.id, f2.id);
  assert.deepEqual(checkPerTreeNameUniqueness(getState()), []);
});

test("invariant 3: a shared taxon clashing in one of its containing trees fires for that tree", () => {
  // T1: Fiction → Thriller (shared). T2: Genres → Thriller (shared) → but T2 also has a sibling named "thriller".
  // Concretely: shared taxon X named "Thriller" lives under R1 (no clash) and R2 (which also has a sibling Y named "Thriller").
  fresh();
  const r1 = createTaxonFixture("R1", "u");
  const r2 = createTaxonFixture("R2", "u");
  const x = createTaxonFixture("Thriller", "u");
  const y = createTaxonFixture("Thriller", "u"); // R2's own existing child
  attachChildFixture(r1.id, x.id);
  attachChildFixture(r2.id, x.id);
  attachChildFixture(r2.id, y.id);
  const violations = checkPerTreeNameUniqueness(getState());
  // Exactly one clash: under R2. R1 is fine (only X named "Thriller").
  assert.equal(violations.length, 1);
  const v = violations[0]!;
  assert.ok(v.kind === "name_clash");
  assert.equal(v.rootId, r2.id);
  assert.equal(v.name, "thriller");
  assert.deepEqual([...v.taxa].sort(), [x.id, y.id].sort());
});

test("invariant 3: rename simulation — a name that clashes in another containing tree is caught", () => {
  // Set up: shared taxon S, name "Initial". R1 has a sibling already
  // named "Conflict". R2 has no sibling named "Conflict".
  // A rename of S "Initial" → "Conflict" is simulated by directly mutating
  // S's name and re-evaluating.
  fresh();
  const r1 = createTaxonFixture("R1", "u");
  const r2 = createTaxonFixture("R2", "u");
  const s = createTaxonFixture("Initial", "u");
  const trap = createTaxonFixture("Conflict", "u"); // sibling in R1
  attachChildFixture(r1.id, s.id);
  attachChildFixture(r2.id, s.id);
  attachChildFixture(r1.id, trap.id);

  // Pre-rename: no clash.
  assert.deepEqual(checkPerTreeNameUniqueness(getState()), []);

  // Rename S to "Conflict". Owner of S sees R2 (where S sits) and notices
  // no sibling collision in R2 — but R1 has one. §3.3 requires the rename
  // to satisfy invariant 3 in EVERY containing tree.
  s.name = "Conflict";
  const violations = checkPerTreeNameUniqueness(getState());
  assert.equal(violations.length, 1);
  const v = violations[0]!;
  assert.ok(v.kind === "name_clash");
  assert.equal(v.rootId, r1.id);
  assert.equal(v.name, "conflict");
  assert.deepEqual([...v.taxa].sort(), [s.id, trap.id].sort());
});

// --- mutual independence (the three invariants don't conflate) -------------

test("evaluateAll: a graph violating only invariant 1 reports cycle, not 2 or 3", () => {
  fresh();
  const a = createTaxonFixture("Alpha", "u");
  attachChildFixture(a.id, a.id); // self-cycle, distinct names trivially
  const result = evaluateAll(getState());
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]!.kind, "cycle");
});

test("evaluateAll: a graph violating only invariant 2 reports duplicate, not 1 or 3", () => {
  fresh();
  const r = createTaxonFixture("R", "u");
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  const x = createTaxonFixture("X", "u"); // unique name, but two paths
  attachChildFixture(r.id, a.id);
  attachChildFixture(r.id, b.id);
  attachChildFixture(a.id, x.id);
  attachChildFixture(b.id, x.id);
  const result = evaluateAll(getState());
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]!.kind, "in_tree_duplicate");
});

test("evaluateAll: a graph violating only invariant 3 reports name_clash, not 1 or 2", () => {
  fresh();
  const r = createTaxonFixture("R", "u");
  const a = createTaxonFixture("Same", "u");
  const b = createTaxonFixture("Same", "u");
  attachChildFixture(r.id, a.id);
  attachChildFixture(r.id, b.id);
  const result = evaluateAll(getState());
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]!.kind, "name_clash");
});

test("evaluateAll: a graph violating BOTH 2 and 3 reports both, attributed correctly", () => {
  // R → A, R → B (sibling); A and B both named "Twin" (invariant 3 violation
  // under R); and X reachable from both A and B (invariant 2 violation
  // under R). The two violations are reported separately.
  fresh();
  const r = createTaxonFixture("R", "u");
  const a = createTaxonFixture("Twin", "u");
  const b = createTaxonFixture("Twin", "u");
  const x = createTaxonFixture("Unique", "u");
  attachChildFixture(r.id, a.id);
  attachChildFixture(r.id, b.id);
  attachChildFixture(a.id, x.id);
  attachChildFixture(b.id, x.id);
  const result = evaluateAll(getState());
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  const kinds = new Set(result.violations.map((v) => v.kind));
  assert.ok(kinds.has("in_tree_duplicate"), "expected invariant 2 violation");
  assert.ok(kinds.has("name_clash"), "expected invariant 3 violation");
  assert.ok(!kinds.has("cycle"), "should not falsely report a cycle");
  // The name_clash names a, b (not x); the in_tree_duplicate names x.
  for (const v of result.violations) {
    if (v.kind === "name_clash") {
      assert.deepEqual([...v.taxa].sort(), [a.id, b.id].sort());
    } else if (v.kind === "in_tree_duplicate") {
      assert.equal(v.taxonId, x.id);
    }
  }
});

// --- evaluateAll: ok-shape on clean graphs --------------------------------

test("evaluateAll: an empty graph is ok:true", () => {
  fresh();
  const result = evaluateAll(getState());
  assert.deepEqual(result, { ok: true });
});

test("evaluateAll: a non-trivial clean multi-tree graph is ok:true", () => {
  fresh();
  // R1: A → B → C (clean linear).
  const a = createTaxonFixture("Fiction", "u");
  const b = createTaxonFixture("Fantasy", "u");
  const c = createTaxonFixture("Epic Fantasy", "u");
  attachChildFixture(a.id, b.id);
  attachChildFixture(b.id, c.id);
  // R2: independent tree.
  const d = createTaxonFixture("Other Genres", "u");
  const e = createTaxonFixture("Mystery", "u");
  attachChildFixture(d.id, e.id);
  // Shared across trees: a new shared taxon — that is fine.
  const s = createTaxonFixture("Shared", "u");
  attachChildFixture(c.id, s.id);
  attachChildFixture(e.id, s.id);
  const result = evaluateAll(getState());
  assert.deepEqual(result, { ok: true });
});
