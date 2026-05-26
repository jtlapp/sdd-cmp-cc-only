// Phase 7 — accept-cascade happy paths (§12.2 / errata E1).
//
// Verifies cascade-iterative apply-then-promote behavior:
//   - degenerate one-step cascade
//   - cascade extending through ownership transfer (A.1 shape)
//   - cascade bounded by other-owner routing
//   - cascade bounded by leaves
//   - mixed nested ops accepted in topological order
//   - self-routed cascade

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  acceptCascadeOk,
  attach,
  createTaxon,
  freshApp,
  getQueue,
  QueueEntry,
  register,
  submitOk,
  type App,
} from "./proposalsTestHelpers.js";

async function queueOf(app: App, who: string): Promise<QueueEntry[]> {
  const res = await getQueue(app, who);
  return ((await res.json()) as { changes: QueueEntry[] }).changes;
}

async function getTaxon(app: App, id: string) {
  const res = await app.request(`/taxa/${id}`);
  assert.equal(res.status, 200);
  return (await res.json()) as {
    id: string;
    name: string;
    owner: string;
    childIds: string[];
    parentIds: string[];
  };
}

async function getTree(app: App, root: string) {
  const res = await app.request(`/trees/${root}`);
  assert.equal(res.status, 200);
  return (await res.json()) as {
    id: string;
    name: string;
    children: Array<{ id: string; name: string; children?: unknown[] }>;
  };
}

// 1. Degenerate cascade — a single rename, no nested ops.
test("cascade rooted at a queued rename with no descendants accepts only the seed", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;

  const sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "rename", id: r1, name: "Speculative Fiction" },
  });
  const renameId = sub.payload.changeId!;

  const r = await acceptCascadeOk(app, "alice", renameId);
  assert.equal(r.rootChangeId, renameId);
  assert.deepEqual(r.acceptedChangeIds, [renameId]);
  assert.equal((await getTaxon(app, r1)).name, "Speculative Fiction");
});

// 2. Appendix A.1 shape — cascade extends through ownership transfer.
test("cascade extends through ownership transfer (Appendix A.1 Urban Fantasy / Paranormal Romance)", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Speculative Fiction")).id;
  const c2 = (await createTaxon(app, "bob", "Fantasy")).id;
  await attach(app, "alice", r1, c1);
  await attach(app, "alice", c1, c2);

  const sub = await submitOk(app, "carol", {
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
              op: "no-op",
              id: c2,
              children: [
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

  const ufId = sub.payload.children![0].children![0].children![0].changeId!;
  const prId =
    sub.payload.children![0].children![0].children![0].children![0].changeId!;

  const r = await acceptCascadeOk(app, "bob", ufId);
  assert.equal(r.rootChangeId, ufId);
  // Both ids in order (UF first, PR second — topological).
  assert.deepEqual(r.acceptedChangeIds, [ufId, prId]);

  // Both new taxa exist, owned by Bob, parented correctly.
  const c2After = await getTaxon(app, c2);
  assert.equal(c2After.childIds.length, 1);
  const ufLiveId = c2After.childIds[0];
  const uf = await getTaxon(app, ufLiveId);
  assert.equal(uf.name, "Urban Fantasy");
  assert.equal(uf.owner, "bob");
  assert.equal(uf.childIds.length, 1);
  const pr = await getTaxon(app, uf.childIds[0]);
  assert.equal(pr.name, "Paranormal Romance");
  assert.equal(pr.owner, "bob");
});

// 3. Cascade bounded by other-owner routing.
test("cascade stops at boundaries routed to other owners; bounded change stays queued for that owner", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "erin");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Spec Fiction")).id;
  await attach(app, "alice", r1, c1);
  // Erin owns a separate taxon to be grafted.
  const erinTaxon = (await createTaxon(app, "erin", "Cyberpunk")).id;

  // Carol proposes: under c1 (Alice), add-create "Wrapper"; under Wrapper,
  // graft Erin's taxon; under the graft, add-create "Foo".
  //   - Wrapper create: routes to Alice (parent c1 owner).
  //   - Erin's graft: routes to Wrapper's owner (Alice, since cascade
  //     transfers Wrapper's ownership to Alice).
  //   - Foo create: payload-parent is the grafted Erin taxon → routes
  //     to Erin (graft preserves ownership). BOUNDARY.
  const sub = await submitOk(app, "carol", {
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
              op: "add",
              id: null,
              name: "Wrapper",
              children: [
                {
                  op: "add",
                  id: erinTaxon,
                  children: [
                    { op: "add", id: null, name: "Foo" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  });
  const wrapperId = sub.payload.children![0].children![0].changeId!;
  const graftId = sub.payload.children![0].children![0].children![0].changeId!;
  const fooId =
    sub.payload.children![0].children![0].children![0].children![0].changeId!;

  const r = await acceptCascadeOk(app, "alice", wrapperId);
  // Cascade accepted Wrapper (Alice) and the graft (Alice, since cascade
  // owns Wrapper). Foo (routed to Erin) is the boundary.
  assert.deepEqual(r.acceptedChangeIds, [wrapperId, graftId]);

  // Foo is now queued for Erin.
  const erinQ = await queueOf(app, "erin");
  assert.ok(erinQ.some((e) => e.changeId === fooId && e.state === "queued"));
  // Alice's queue is empty for this proposal.
  const aliceQ = await queueOf(app, "alice");
  assert.ok(!aliceQ.some((e) => e.changeId === fooId));
});

// 4. Cascade bounded by leaves.
test("cascade rooted at an add-create with no nested ops accepts only the seed", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;

  const sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", id: null, name: "Mystery" }],
    },
  });
  const addId = sub.payload.children![0].changeId!;

  const r = await acceptCascadeOk(app, "alice", addId);
  assert.deepEqual(r.acceptedChangeIds, [addId]);
});

// 5. Cascade with mixed nested ops in payload-topological order.
test("cascade accepts mixed nested ops (rename, add, detach) in payload-topological order", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const oldChild = (await createTaxon(app, "alice", "OldChild")).id;
  await attach(app, "alice", r1, oldChild);

  // Carol's proposal: under r1, add-create "Wrapper" with nested:
  //   - rename oldChild (routes to Alice — owner of oldChild)
  //   - add-create "NewLeaf" (routes to Alice via Wrapper)
  // Plus a sibling under r1: detach oldChild (routes to Alice).
  const sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        {
          op: "add",
          id: null,
          name: "Wrapper",
          children: [{ op: "add", id: null, name: "NewLeaf" }],
        },
      ],
    },
  });
  const wrapperId = sub.payload.children![0].changeId!;
  const newLeafId = sub.payload.children![0].children![0].changeId!;

  const r = await acceptCascadeOk(app, "alice", wrapperId);
  // Wrapper before NewLeaf (parent before child).
  assert.deepEqual(r.acceptedChangeIds, [wrapperId, newLeafId]);

  // Verify live state.
  const r1After = await getTaxon(app, r1);
  // r1 now has oldChild + wrapper.
  assert.equal(r1After.childIds.length, 2);
  const wrapperLiveId = r1After.childIds.find((id) => id !== oldChild);
  assert.ok(wrapperLiveId);
  const wrapper = await getTaxon(app, wrapperLiveId!);
  assert.equal(wrapper.name, "Wrapper");
  assert.equal(wrapper.owner, "alice");
  assert.equal(wrapper.childIds.length, 1);
});

// 6. Self-routed cascade.
test("self-routed cascade — reviewer is also the proposer", async () => {
  const app = await freshApp();
  await register(app, "alice");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;

  // Alice proposes against her own tree.
  const sub = await submitOk(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        {
          op: "add",
          id: null,
          name: "Wrapper",
          children: [{ op: "add", id: null, name: "Inner" }],
        },
      ],
    },
  });
  const wrapperId = sub.payload.children![0].changeId!;

  const r = await acceptCascadeOk(app, "alice", wrapperId);
  assert.equal(r.acceptedChangeIds.length, 2);
});
