// PRD §10.1 — per-op routing assertions.
//
// Each change is routed to a single reviewer:
//   rename → owner of the renamed taxon (the id)
//   detach → owner of the payload-parent
//   add (create or graft) → owner of the payload-parent
//   no-op → produces no change
//
// Routing observability: a queued change appears in EXACTLY ONE reviewer's
// /queue. We seed multi-owner state, submit a proposal, then read /queue
// from each candidate reviewer and pin who sees what.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  attach,
  createTaxon,
  freshApp,
  getQueue,
  QueueEntry,
  register,
  submitOk,
} from "./proposalsTestHelpers.js";

async function queueOf(app: Awaited<ReturnType<typeof freshApp>>, who: string) {
  const res = await getQueue(app, who);
  assert.equal(res.status, 200);
  return ((await res.json()) as { changes: QueueEntry[] }).changes;
}

// --- per-op routing --------------------------------------------------------

test("rename routes to the renamed taxon's owner, not the parent's", async () => {
  // r1 (Alice), c1 (Bob) under r1
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "bob", "Fantasy")).id;
  await attach(app, "alice", r1, c1);

  await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c1, name: "Epic Fantasy" }],
    },
  });

  // Bob (owner of the renamed taxon) sees it.
  const bobQ = await queueOf(app, "bob");
  assert.equal(bobQ.length, 1);
  assert.equal(bobQ[0].op, "rename");
  assert.equal(bobQ[0].taxonId, c1);
  assert.equal(bobQ[0].name, "Epic Fantasy");
  // Alice (owner of the parent) does NOT see it.
  const aliceQ = await queueOf(app, "alice");
  assert.equal(aliceQ.length, 0);
  // Carol (proposer) does NOT see it.
  const carolQ = await queueOf(app, "carol");
  assert.equal(carolQ.length, 0);
});

test("detach routes to the payload-parent's owner, not the child's", async () => {
  // r1 (Alice), c1 (Bob) under r1
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "bob", "Fantasy")).id;
  await attach(app, "alice", r1, c1);

  await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "detach", id: c1 }],
    },
  });

  const aliceQ = await queueOf(app, "alice");
  assert.equal(aliceQ.length, 1);
  assert.equal(aliceQ[0].op, "detach");
  assert.equal(aliceQ[0].taxonId, c1);
  assert.equal(aliceQ[0].payloadParentTaxonId, r1);

  assert.equal((await queueOf(app, "bob")).length, 0);
  assert.equal((await queueOf(app, "carol")).length, 0);
});

test("add-create routes to the payload-parent's owner", async () => {
  // r1 (Alice)
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;

  await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", id: null, name: "Speculative Fiction" }],
    },
  });

  const aliceQ = await queueOf(app, "alice");
  assert.equal(aliceQ.length, 1);
  assert.equal(aliceQ[0].op, "add");
  assert.equal(aliceQ[0].name, "Speculative Fiction");
  assert.equal(aliceQ[0].payloadParentTaxonId, r1);
  assert.equal(aliceQ[0].taxonId, undefined);
});

test("add-graft routes to the payload-parent's owner (not the grafted taxon's)", async () => {
  // r1 (Alice); separately Bob owns a freestanding taxon to graft.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const orphan = (await createTaxon(app, "bob", "Mystery")).id;

  await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", id: orphan }],
    },
  });

  const aliceQ = await queueOf(app, "alice");
  assert.equal(aliceQ.length, 1);
  assert.equal(aliceQ[0].op, "add");
  assert.equal(aliceQ[0].taxonId, orphan);
  assert.equal(aliceQ[0].payloadParentTaxonId, r1);
  // Bob (owner of the grafted taxon) is NOT the graft's reviewer.
  assert.equal((await queueOf(app, "bob")).length, 0);
});

test("no-op produces no change in any queue", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1 },
  });
  assert.equal((await queueOf(app, "alice")).length, 0);
  assert.equal((await queueOf(app, "carol")).length, 0);
});

// --- §10.1 keystone: ops nested under a taxon route differently than the
// rename of the taxon itself.

test("rename + nested add under same taxon route to different/same reviewers per §10.1", async () => {
  // r1 (Alice), c2 (Bob) under r1
  // Payload: rename(c2) + nested add-create under c2.
  // rename(c2) → Bob (owner of c2)
  // nested add  → Bob (c2 is the payload-parent and Bob owns c2)
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c2 = (await createTaxon(app, "bob", "Fantasy")).id;
  await attach(app, "alice", r1, c2);

  await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        {
          op: "rename",
          id: c2,
          name: "Renamed Fantasy",
          children: [{ op: "add", id: null, name: "Urban Fantasy" }],
        },
      ],
    },
  });

  const bobQ = await queueOf(app, "bob");
  // The rename to Bob, plus the add-create to Bob (c2's owner is the add's
  // payload-parent owner). The add has rename(c2) as ancestor — rename is
  // an existence dep, not a decision dep, so the add queues immediately.
  assert.equal(bobQ.length, 2);
  const ops = bobQ.map((e) => e.op).sort();
  assert.deepEqual(ops, ["add", "rename"]);
  assert.equal((await queueOf(app, "alice")).length, 0);
  assert.equal((await queueOf(app, "carol")).length, 0);
});

test("rename targeting C + nested add → both route to C's owner", async () => {
  // r1 (Alice), r2_child (Carol) under r1. Payload: rename(r2_child) +
  // nested add-create. Rename routes to Carol; nested add routes to Carol
  // (her taxon is the payload-parent).
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  await register(app, "dave");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const carolNode = (await createTaxon(app, "carol", "Suspense")).id;
  await attach(app, "alice", r1, carolNode);

  await submitOk(app, "dave", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        {
          op: "rename",
          id: carolNode,
          name: "Suspense and Discovery Fiction",
          children: [{ op: "add", id: null, name: "Mystery" }],
        },
      ],
    },
  });

  const carolQ = await queueOf(app, "carol");
  assert.equal(carolQ.length, 2);
  assert.equal((await queueOf(app, "alice")).length, 0);
  assert.equal((await queueOf(app, "dave")).length, 0);
});

// --- §9.3 keystone: graft preserves ownership in routing -------------------

test("graft preserves ownership: nested ops under graft route to grafted taxon's owner", async () => {
  // Frank owns b1 → b2. Erin owns a3 (freestanding in T1).
  // Proposal: under b2, add-graft a3, with nested add-create under a3.
  // graft(a3)            → Frank (owner of b2, the payload-parent)
  // nested add-create    → Erin (owner of a3, the payload-parent for nested)
  //                        — even though the change is LATENT (decision dep
  //                        on the graft), its reviewer is well-known at
  //                        submission. But Phase 5 only surfaces queued
  //                        changes via /queue, so Erin's queue is empty
  //                        until Phase 6 promotion.
  const app = await freshApp();
  await register(app, "frank");
  await register(app, "erin");
  await register(app, "grace");
  const b1 = (await createTaxon(app, "frank", "Genre Index")).id;
  const b2 = (await createTaxon(app, "frank", "Dark Fiction")).id;
  await attach(app, "frank", b1, b2);
  const a3 = (await createTaxon(app, "erin", "Psychological Thriller")).id;

  await submitOk(app, "grace", {
    targetRootId: b1,
    topTaxonId: b1,
    payload: {
      op: "no-op",
      id: b1,
      children: [
        {
          op: "no-op",
          id: b2,
          children: [
            {
              op: "add",
              id: a3,
              children: [
                { op: "add", id: null, name: "Unreliable Narrator Thriller" },
              ],
            },
          ],
        },
      ],
    },
  });

  const frankQ = await queueOf(app, "frank");
  assert.equal(frankQ.length, 1);
  assert.equal(frankQ[0].op, "add");
  assert.equal(frankQ[0].taxonId, a3);
  assert.equal(frankQ[0].payloadParentTaxonId, b2);
  // Erin's nested add is LATENT (under the graft) → not in any queue.
  assert.equal((await queueOf(app, "erin")).length, 0);
});

// --- Cross-tree side effect ------------------------------------------------

test("proposer is not auto-reviewer of her own proposal", async () => {
  // Carol proposes against Alice's tree only.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", id: null, name: "Speculative Fiction" }],
    },
  });
  assert.equal((await queueOf(app, "carol")).length, 0);
  assert.equal((await queueOf(app, "alice")).length, 1);
});
