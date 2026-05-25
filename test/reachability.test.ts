// PRD §3.2, §3.3 — reachability layer over hand-built graphs.
// Pure unit tests; no HTTP.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  attachChildFixture,
  clear,
  createTaxonFixture,
  getState,
} from "../src/taxa.js";
import {
  descendants,
  inTreeDuplicates,
  inTreeVisitCounts,
  isShared,
  roots,
  treesContaining,
} from "../src/reachability.js";

function fresh() {
  clear();
}

// --- roots -----------------------------------------------------------------

test("reachability: empty graph has no roots", () => {
  fresh();
  assert.deepEqual(roots(getState()), []);
});

test("reachability: a single isolated taxon is its own root", () => {
  fresh();
  const a = createTaxonFixture("A", "u");
  assert.deepEqual(roots(getState()), [a.id]);
});

test("reachability: in a chain A→B→C, only A is a root", () => {
  fresh();
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  const c = createTaxonFixture("C", "u");
  attachChildFixture(a.id, b.id);
  attachChildFixture(b.id, c.id);
  assert.deepEqual(roots(getState()), [a.id]);
});

test("reachability: cross-tree diamond (A→C, B→C) has roots [A, B]", () => {
  fresh();
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  const c = createTaxonFixture("C", "u");
  attachChildFixture(a.id, c.id);
  attachChildFixture(b.id, c.id);
  assert.deepEqual(roots(getState()), [a.id, b.id]);
});

test("reachability: detach makes a previously-child taxon a root again", async () => {
  const { detachChildFixture } = await import("../src/taxa.js");
  fresh();
  const a = createTaxonFixture("A", "u");
  const c = createTaxonFixture("C", "u");
  attachChildFixture(a.id, c.id);
  assert.deepEqual(roots(getState()), [a.id]);
  detachChildFixture(a.id, c.id);
  assert.deepEqual(roots(getState()), [a.id, c.id]);
});

// --- treesContaining --------------------------------------------------------

test("reachability: in chain A→B→C, every taxon's containing tree is {A}", () => {
  fresh();
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  const c = createTaxonFixture("C", "u");
  attachChildFixture(a.id, b.id);
  attachChildFixture(b.id, c.id);
  const s = getState();
  assert.deepEqual(treesContaining(a.id, s), [a.id]);
  assert.deepEqual(treesContaining(b.id, s), [a.id]);
  assert.deepEqual(treesContaining(c.id, s), [a.id]);
});

test("reachability: cross-tree diamond — C's containing trees are {A, B}", () => {
  fresh();
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  const c = createTaxonFixture("C", "u");
  attachChildFixture(a.id, c.id);
  attachChildFixture(b.id, c.id);
  assert.deepEqual(treesContaining(c.id, getState()), [a.id, b.id]);
});

test("reachability: deeper multi-root graph — D in two trees, B in one", () => {
  // A → B → D, C → D. Two roots (A, C); D in {A, C}; B in {A}.
  fresh();
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  const c = createTaxonFixture("C", "u");
  const d = createTaxonFixture("D", "u");
  attachChildFixture(a.id, b.id);
  attachChildFixture(b.id, d.id);
  attachChildFixture(c.id, d.id);
  const s = getState();
  assert.deepEqual(treesContaining(d.id, s), [a.id, c.id]);
  assert.deepEqual(treesContaining(b.id, s), [a.id]);
});

test("reachability: a taxon with no parents is its own containing tree", () => {
  fresh();
  const a = createTaxonFixture("A", "u");
  assert.deepEqual(treesContaining(a.id, getState()), [a.id]);
});

test("reachability: treesContaining on an unknown id returns []", () => {
  fresh();
  assert.deepEqual(treesContaining("nope", getState()), []);
});

// --- isShared --------------------------------------------------------------

test("reachability: an isolated root is not shared", () => {
  fresh();
  const a = createTaxonFixture("A", "u");
  assert.equal(isShared(a.id, getState()), false);
});

test("reachability: a linear-chain taxon is not shared", () => {
  fresh();
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  attachChildFixture(a.id, b.id);
  assert.equal(isShared(b.id, getState()), false);
});

test("reachability: a taxon reachable from two distinct roots is shared", () => {
  fresh();
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  const c = createTaxonFixture("C", "u");
  attachChildFixture(a.id, c.id);
  attachChildFixture(b.id, c.id);
  assert.equal(isShared(c.id, getState()), true);
});

test("reachability: in-tree diamond does NOT make a taxon shared (single root)", () => {
  // R → A, R → B, A → X, B → X — X is reachable by two paths from the
  // SAME root R; that's an invariant-2 violation, not "sharing".
  fresh();
  const r = createTaxonFixture("R", "u");
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  const x = createTaxonFixture("X", "u");
  attachChildFixture(r.id, a.id);
  attachChildFixture(r.id, b.id);
  attachChildFixture(a.id, x.id);
  attachChildFixture(b.id, x.id);
  assert.equal(isShared(x.id, getState()), false);
});

// --- in-tree duplicates ----------------------------------------------------

test("reachability: a clean tree reports no in-tree duplicates", () => {
  fresh();
  const r = createTaxonFixture("R", "u");
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  attachChildFixture(r.id, a.id);
  attachChildFixture(r.id, b.id);
  assert.deepEqual(inTreeDuplicates(r.id, getState()), []);
});

test("reachability: in-tree diamond reports the duplicated taxon", () => {
  fresh();
  const r = createTaxonFixture("R", "u");
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  const x = createTaxonFixture("X", "u");
  attachChildFixture(r.id, a.id);
  attachChildFixture(r.id, b.id);
  attachChildFixture(a.id, x.id);
  attachChildFixture(b.id, x.id);
  assert.deepEqual(inTreeDuplicates(r.id, getState()), [x.id]);
});

test("reachability: cross-tree diamond is NOT an in-tree duplicate in either tree", () => {
  fresh();
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  const c = createTaxonFixture("C", "u");
  attachChildFixture(a.id, c.id);
  attachChildFixture(b.id, c.id);
  assert.deepEqual(inTreeDuplicates(a.id, getState()), []);
  assert.deepEqual(inTreeDuplicates(b.id, getState()), []);
});

test("reachability: visit counts pin path-count semantics on a diamond", () => {
  fresh();
  const r = createTaxonFixture("R", "u");
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  const x = createTaxonFixture("X", "u");
  attachChildFixture(r.id, a.id);
  attachChildFixture(r.id, b.id);
  attachChildFixture(a.id, x.id);
  attachChildFixture(b.id, x.id);
  const counts = inTreeVisitCounts(r.id, getState());
  assert.equal(counts.get(r.id), 1);
  assert.equal(counts.get(a.id), 1);
  assert.equal(counts.get(b.id), 1);
  assert.equal(counts.get(x.id), 2);
});

// --- descendants -----------------------------------------------------------

test("reachability: descendants of a leaf is empty", () => {
  fresh();
  const a = createTaxonFixture("A", "u");
  assert.deepEqual(descendants(a.id, getState()), []);
});

test("reachability: descendants from the root covers the whole tree", () => {
  fresh();
  const r = createTaxonFixture("R", "u");
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  const c = createTaxonFixture("C", "u");
  attachChildFixture(r.id, a.id);
  attachChildFixture(a.id, b.id);
  attachChildFixture(a.id, c.id);
  const d = descendants(r.id, getState());
  assert.deepEqual(d.sort(), [a.id, b.id, c.id].sort());
});

test("reachability: descendants from mid-tree is the strict downward closure", () => {
  fresh();
  const r = createTaxonFixture("R", "u");
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  attachChildFixture(r.id, a.id);
  attachChildFixture(a.id, b.id);
  assert.deepEqual(descendants(a.id, getState()), [b.id]);
  // r is NOT a descendant of a.
  assert.equal(descendants(a.id, getState()).includes(r.id), false);
});

test("reachability: descendants is cycle-safe", () => {
  fresh();
  // Fixture-only construction lets us build a cyclic graph deliberately.
  const a = createTaxonFixture("A", "u");
  const b = createTaxonFixture("B", "u");
  attachChildFixture(a.id, b.id);
  attachChildFixture(b.id, a.id);
  // No infinite loop; both A and B appear at most once.
  const d = descendants(a.id, getState());
  assert.deepEqual(d.sort(), [a.id, b.id].sort());
});
