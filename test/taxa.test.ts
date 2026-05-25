// PRD §2 + §3.1 — in-memory taxon store, server-assigned monotonic IDs,
// insertion-ordered child/parent edges, fixture primitives, reset.
//
// These are pure unit tests against src/taxa.ts module state. Per the
// toolchain supplement, tests that touch the store call clear() (or the
// HTTP /reset, in the integration suite) first so no state leaks across
// tests.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allTaxa,
  attachChildFixture,
  childrenOfTaxon,
  clear,
  createTaxonFixture,
  detachChildFixture,
  getState,
  getTaxon,
  parentsOfTaxon,
} from "../src/taxa.js";

function freshStore() {
  clear();
}

// --- empty / clean state ---------------------------------------------------

test("taxa: a freshly-reset store has zero taxa", () => {
  freshStore();
  assert.deepEqual(allTaxa(), []);
  assert.equal(getTaxon("t1"), undefined);
});

test("taxa: getState exposes empty taxa and parentsOf maps after reset", () => {
  freshStore();
  const s = getState();
  assert.equal(s.taxa.size, 0);
  assert.equal(s.parentsOf.size, 0);
});

// --- ID generation ---------------------------------------------------------

test("taxa: createTaxonFixture assigns t1, t2, t3 in monotonic order", () => {
  freshStore();
  const a = createTaxonFixture("A", "alice");
  const b = createTaxonFixture("B", "alice");
  const c = createTaxonFixture("C", "bob");
  assert.equal(a.id, "t1");
  assert.equal(b.id, "t2");
  assert.equal(c.id, "t3");
});

test("taxa: each new taxon starts with empty childIds and no parents", () => {
  freshStore();
  const a = createTaxonFixture("A", "alice");
  assert.equal(a.childIds.size, 0);
  assert.deepEqual(parentsOfTaxon(a.id), []);
});

test("taxa: name and owner are stored verbatim (no format enforcement in the store)", () => {
  // The store does not validate; that's the Phase 1 validator's job and
  // Phase 4 will compose them. Fixtures may pass any string.
  freshStore();
  const t = createTaxonFixture("  weird name  ", "Whoever");
  assert.equal(t.name, "  weird name  ");
  assert.equal(t.owner, "Whoever");
});

// --- edges -----------------------------------------------------------------

test("taxa: attaching a child puts it on the parent's childIds in attachment order", () => {
  freshStore();
  const r = createTaxonFixture("R", "alice");
  const a = createTaxonFixture("A", "alice");
  const b = createTaxonFixture("B", "alice");
  attachChildFixture(r.id, a.id);
  attachChildFixture(r.id, b.id);
  assert.deepEqual(childrenOfTaxon(r.id), [a.id, b.id]);
});

test("taxa: the derived parent set lists parents in attachment order", () => {
  freshStore();
  const a = createTaxonFixture("A", "alice");
  const b = createTaxonFixture("B", "alice");
  const c = createTaxonFixture("C", "alice");
  attachChildFixture(a.id, c.id);
  attachChildFixture(b.id, c.id);
  assert.deepEqual(parentsOfTaxon(c.id), [a.id, b.id]);
});

test("taxa: re-attaching the same edge is idempotent", () => {
  freshStore();
  const r = createTaxonFixture("R", "alice");
  const a = createTaxonFixture("A", "alice");
  attachChildFixture(r.id, a.id);
  attachChildFixture(r.id, a.id);
  assert.deepEqual(childrenOfTaxon(r.id), [a.id]);
  assert.deepEqual(parentsOfTaxon(a.id), [r.id]);
});

test("taxa: detachChildFixture removes the edge from both endpoints", () => {
  freshStore();
  const r = createTaxonFixture("R", "alice");
  const a = createTaxonFixture("A", "alice");
  attachChildFixture(r.id, a.id);
  detachChildFixture(r.id, a.id);
  assert.deepEqual(childrenOfTaxon(r.id), []);
  assert.deepEqual(parentsOfTaxon(a.id), []);
});

test("taxa: detachChildFixture on a non-existent edge is a no-op", () => {
  freshStore();
  const r = createTaxonFixture("R", "alice");
  const a = createTaxonFixture("A", "alice");
  // No attach, but detach should not throw.
  detachChildFixture(r.id, a.id);
  assert.deepEqual(childrenOfTaxon(r.id), []);
  assert.deepEqual(parentsOfTaxon(a.id), []);
});

test("taxa: attachChildFixture throws on unknown parent or child (fixture-author bug)", () => {
  freshStore();
  const r = createTaxonFixture("R", "alice");
  assert.throws(() => attachChildFixture("nope", r.id), /unknown parent/);
  assert.throws(() => attachChildFixture(r.id, "nope"), /unknown child/);
});

test("taxa: deeply-nested attachments preserve insertion order and per-id distinctness", () => {
  freshStore();
  const r = createTaxonFixture("R", "alice");
  const a = createTaxonFixture("A", "alice");
  const b = createTaxonFixture("B", "alice");
  const c = createTaxonFixture("C", "alice");
  attachChildFixture(r.id, a.id);
  attachChildFixture(a.id, b.id);
  attachChildFixture(a.id, c.id);
  assert.deepEqual(childrenOfTaxon(r.id), [a.id]);
  assert.deepEqual(childrenOfTaxon(a.id), [b.id, c.id]);
});

// --- reset -----------------------------------------------------------------

test("taxa: clear() empties the store AND resets the ID counter", () => {
  freshStore();
  createTaxonFixture("A", "alice");
  createTaxonFixture("B", "alice");
  clear();
  assert.deepEqual(allTaxa(), []);
  // Counter reset: next allocation is t1 again.
  const t = createTaxonFixture("first-after-reset", "alice");
  assert.equal(t.id, "t1");
});

test("taxa: clear() removes edges from the parents-of index too", () => {
  freshStore();
  const r = createTaxonFixture("R", "alice");
  const a = createTaxonFixture("A", "alice");
  attachChildFixture(r.id, a.id);
  clear();
  const s = getState();
  assert.equal(s.parentsOf.size, 0);
});

test("taxa: allTaxa returns taxa in creation order (insertion-ordered Map)", () => {
  freshStore();
  const ids: string[] = [];
  for (const name of ["A", "B", "C", "D"]) ids.push(createTaxonFixture(name, "x").id);
  assert.deepEqual(allTaxa().map((t) => t.id), ids);
});
