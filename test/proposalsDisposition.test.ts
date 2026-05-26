// PRD §11.3 — boundary cases for the initial latent/queued disposition.
//
// The decision-dependency rule is "any add ancestor on the payload path";
// these tests pin the boundaries where the disposition flips, and the
// invariants that queue-placement matches disposition.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  attach,
  createTaxon,
  freshApp,
  getQueue,
  ProposalResponse,
  QueueEntry,
  register,
  submitOk,
  walkStatusNodes,
} from "./proposalsTestHelpers.js";

async function queueOf(app: Awaited<ReturnType<typeof freshApp>>, who: string) {
  const res = await getQueue(app, who);
  assert.equal(res.status, 200);
  return ((await res.json()) as { changes: QueueEntry[] }).changes;
}

// --- Boundary cases --------------------------------------------------------

test("exactly one decision-dep ancestor → latent", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const resp = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        {
          op: "add",
          id: null,
          name: "Outer",
          children: [{ op: "add", id: null, name: "Inner" }],
        },
      ],
    },
  });
  const inner = walkStatusNodes(resp.payload).find((n) => n.name === "Inner")!;
  assert.equal(inner.disposition, "latent");
});

test("two decision-dep ancestors → still latent (any add ancestor suffices)", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const resp = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        {
          op: "add",
          id: null,
          name: "A",
          children: [
            {
              op: "add",
              id: null,
              name: "B",
              children: [{ op: "add", id: null, name: "C" }],
            },
          ],
        },
      ],
    },
  });
  const ops = walkStatusNodes(resp.payload).filter((n) => n.op !== "no-op");
  const a = ops.find((n) => n.name === "A")!;
  const b = ops.find((n) => n.name === "B")!;
  const c = ops.find((n) => n.name === "C")!;
  assert.equal(a.disposition, "queued");
  assert.equal(b.disposition, "latent");
  assert.equal(c.disposition, "latent");
});

test("deep no-op/rename chain (no add anywhere) → terminal change queued", async () => {
  // r1 → c1 → c1a → leaf, all Alice. Top no-op, two nested no-ops, then a
  // rename. No decision deps; the rename must queue.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "A")).id;
  const c1 = (await createTaxon(app, "alice", "B")).id;
  const c1a = (await createTaxon(app, "alice", "C")).id;
  const leaf = (await createTaxon(app, "alice", "D")).id;
  await attach(app, "alice", r1, c1);
  await attach(app, "alice", c1, c1a);
  await attach(app, "alice", c1a, leaf);
  const resp = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        {
          op: "no-op",
          id: c1,
          children: [
            {
              op: "rename",
              id: c1a,
              name: "Cprime",
              children: [{ op: "detach", id: leaf }],
            },
          ],
        },
      ],
    },
  });
  const ops = walkStatusNodes(resp.payload).filter((n) => n.op !== "no-op");
  for (const op of ops) {
    assert.equal(op.disposition, "queued");
  }
});

test("sibling ops don't gate each other (an add sibling doesn't make a rename sibling latent)", async () => {
  // r1 (Alice), c1 (Alice). Under r1: add-create AND rename(c1).
  // Both are queued; neither is on the other's path.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Fantasy")).id;
  await attach(app, "alice", r1, c1);
  const resp: ProposalResponse = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        { op: "add", id: null, name: "Speculative Fiction" },
        { op: "rename", id: c1, name: "Epic Fantasy" },
      ],
    },
  });
  const ops = walkStatusNodes(resp.payload).filter((n) => n.op !== "no-op");
  assert.equal(ops.length, 2);
  for (const op of ops) {
    assert.equal(op.disposition, "queued");
  }
});

test("no-op payload node is structural, carries no changeId", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Fantasy")).id;
  await attach(app, "alice", r1, c1);
  const resp = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "no-op", id: c1 }],
    },
  });
  const noops = walkStatusNodes(resp.payload).filter((n) => n.op === "no-op");
  assert.equal(noops.length, 2);
  for (const n of noops) {
    assert.equal(n.disposition, "structural");
    assert.equal(n.changeId, undefined);
  }
});

// --- Queue placement matches disposition -----------------------------------

test("every queued change has exactly one entry; every latent change has zero", async () => {
  // Mix: Appendix A.1 shape. Queued: rename(c1), rename(c3), add Urban
  // Fantasy. Latent: add Paranormal Romance.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Speculative Fiction")).id;
  const c2 = (await createTaxon(app, "bob", "Fantasy")).id;
  const c3 = (await createTaxon(app, "bob", "Epic Fantasy")).id;
  await attach(app, "alice", r1, c1);
  await attach(app, "alice", c1, c2);
  await attach(app, "bob", c2, c3);

  const resp = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        {
          op: "rename",
          id: c1,
          name: "Speculative and Imaginative Fiction",
          children: [
            {
              op: "no-op",
              id: c2,
              children: [
                { op: "rename", id: c3, name: "High Fantasy" },
                {
                  op: "add",
                  id: null,
                  name: "Urban Fantasy",
                  children: [
                    { op: "add", id: null, name: "Paranormal Romance" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  });

  const allQueued: string[] = [];
  for (const who of ["alice", "bob", "carol"]) {
    const q = await queueOf(app, who);
    for (const e of q) allQueued.push(e.changeId);
  }

  const ops = walkStatusNodes(resp.payload).filter((n) => n.op !== "no-op");
  const queued = ops.filter((n) => n.disposition === "queued");
  const latent = ops.filter((n) => n.disposition === "latent");

  // Every queued change appears in exactly one reviewer's queue.
  assert.equal(allQueued.length, queued.length);
  for (const q of queued) {
    assert.ok(allQueued.includes(q.changeId!), `queued ${q.changeId} missing from queues`);
  }
  // No latent change is in any queue.
  for (const l of latent) {
    assert.ok(!allQueued.includes(l.changeId!), `latent ${l.changeId} should not be in any queue`);
  }
});
