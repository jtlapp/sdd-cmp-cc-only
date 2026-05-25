// PRD §6.3 — pure deletion planner (src/deletion.ts).
//
// Unit tests over fixture-built state; complements the HTTP-boundary tests
// in taxaDelete.test.ts by pinning the planner's behavior on hand-built
// shapes that would be hard to express through the writes alone (e.g.
// multi-parent in-tree pathologies).

import { test } from "node:test";
import assert from "node:assert/strict";

import { planDeletion } from "../src/deletion.js";
import {
  attachChildFixture,
  createTaxonFixture,
  getState,
} from "../src/taxa.js";
import { resetAllState } from "../src/state.js";

function setup() {
  resetAllState();
}

test("planDeletion: lone root → region [N]", () => {
  setup();
  const n = createTaxonFixture("N", "alice");
  const res = planDeletion(n.id, "alice", getState());
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.plan.region, [n.id]);
});

test("planDeletion: wholly-U-owned subtree → entire subtree in region", () => {
  setup();
  const n = createTaxonFixture("N", "alice");
  const a = createTaxonFixture("A", "alice");
  const b = createTaxonFixture("B", "alice");
  attachChildFixture(n.id, a.id);
  attachChildFixture(n.id, b.id);

  const res = planDeletion(n.id, "alice", getState());
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual([...res.plan.region].sort(), [n.id, a.id, b.id].sort());
  }
});

test("planDeletion: halt at other-owned child — region stops before it", () => {
  setup();
  const n = createTaxonFixture("N", "alice");
  const c = createTaxonFixture("C", "bob");
  attachChildFixture(n.id, c.id);

  const res = planDeletion(n.id, "alice", getState());
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.plan.region, [n.id]);
});

test("planDeletion: stranded U-owned descendant beneath an other-owned halt is NOT in region", () => {
  setup();
  // N(Alice) → C(Bob) → D(Alice). The walk halts at C, so D is unreachable
  // through a wholly-Alice path — not in region.
  const n = createTaxonFixture("N", "alice");
  const c = createTaxonFixture("C", "bob");
  const d = createTaxonFixture("D", "alice");
  attachChildFixture(n.id, c.id);
  attachChildFixture(c.id, d.id);

  const res = planDeletion(n.id, "alice", getState());
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.plan.region, [n.id]);
});

test("planDeletion: precondition 1 — region taxon is shared → violation shared_in_region", () => {
  setup();
  const p1 = createTaxonFixture("P1", "alice");
  const p2 = createTaxonFixture("P2", "alice");
  const n = createTaxonFixture("N", "alice");
  attachChildFixture(p1.id, n.id);
  attachChildFixture(p2.id, n.id);

  const res = planDeletion(n.id, "alice", getState());
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.violation.kind, "shared_in_region");
    if (res.violation.kind === "shared_in_region") {
      assert.equal(res.violation.taxonId, n.id);
    }
  }
});

test("planDeletion: precondition 1 — a region descendant is shared into another tree", () => {
  setup();
  const n = createTaxonFixture("N", "alice");
  const other = createTaxonFixture("Other", "alice");
  const x = createTaxonFixture("X", "alice");
  attachChildFixture(n.id, x.id);
  attachChildFixture(other.id, x.id);

  const res = planDeletion(n.id, "alice", getState());
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.violation.kind, "shared_in_region");
    if (res.violation.kind === "shared_in_region") {
      assert.equal(res.violation.taxonId, x.id);
    }
  }
});

test("planDeletion: precondition 2 — N has one foreign-owned parent → violation parent_not_owned", () => {
  setup();
  const p = createTaxonFixture("P", "bob");
  const n = createTaxonFixture("N", "alice");
  attachChildFixture(p.id, n.id);

  const res = planDeletion(n.id, "alice", getState());
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.violation.kind, "parent_not_owned");
    if (res.violation.kind === "parent_not_owned") {
      assert.equal(res.violation.parentId, p.id);
      assert.equal(res.violation.parentOwner, "bob");
    }
  }
});

test("planDeletion: precondition 2 — N has one U-owned parent → ok", () => {
  setup();
  const p = createTaxonFixture("P", "alice");
  const n = createTaxonFixture("N", "alice");
  attachChildFixture(p.id, n.id);

  const res = planDeletion(n.id, "alice", getState());
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.plan.region, [n.id]);
});

test("planDeletion: an other-owned halt-frontier taxon may itself be shared — does NOT trip precondition 1", () => {
  setup();
  // N(Alice) → C(Bob); M(Bob) → C(Bob). C is shared, but C is at the
  // halt frontier, not in the region.
  const n = createTaxonFixture("N", "alice");
  const m = createTaxonFixture("M", "bob");
  const c = createTaxonFixture("C", "bob");
  attachChildFixture(n.id, c.id);
  attachChildFixture(m.id, c.id);

  const res = planDeletion(n.id, "alice", getState());
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.plan.region, [n.id]);
});
