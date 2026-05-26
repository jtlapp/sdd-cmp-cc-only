// Phase-6 single-accept happy paths: each op (rename, add-create,
// add-graft, detach) accepts end-to-end and produces the documented
// live-state effect. Covers §12.1, plus the §5/§12.1 ownership transfer
// on create-accept and the §9.3 graft-preserves-ownership clause.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  acceptOk,
  attach,
  createTaxon,
  freshApp,
  getQueue,
  QueueEntry,
  register,
  submitOk,
  type App,
} from "./proposalsTestHelpers.js";

async function getTaxonRecord(app: App, id: string) {
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

async function queueOf(app: App, who: string): Promise<QueueEntry[]> {
  const res = await getQueue(app, who);
  return ((await res.json()) as { changes: QueueEntry[] }).changes;
}

test("accept rename: live taxon name updates, change becomes accepted, dequeued", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;

  const sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "rename", id: r1, name: "Speculative Fiction" },
  });
  const changeId = sub.payload.changeId!;
  assert.equal(sub.payload.disposition, "queued");

  // Reviewer = Alice (owner of r1).
  const ack = await acceptOk(app, "alice", changeId);
  assert.deepEqual(ack, { changeId, state: "accepted" });

  // Live state: r1 renamed.
  const after = await getTaxonRecord(app, r1);
  assert.equal(after.name, "Speculative Fiction");
  assert.equal(after.owner, "alice");

  // Alice's queue no longer holds the change.
  assert.equal((await queueOf(app, "alice")).length, 0);

  // Status view: accepted.
  const status = await app.request(`/proposals/${sub.id}`);
  const body = (await status.json()) as { payload: { changeId: string; disposition: string } };
  assert.equal(body.payload.changeId, changeId);
  assert.equal(body.payload.disposition, "accepted");
});

test("accept add-create: new taxon owned by accepting reviewer, attached to parent", async () => {
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
      children: [{ op: "add", id: null, name: "Fantasy" }],
    },
  });
  const changeId = sub.payload.children![0].changeId!;

  await acceptOk(app, "alice", changeId);

  // r1 now has one child whose name is "Fantasy" and whose owner is Alice.
  const r1After = await getTaxonRecord(app, r1);
  assert.equal(r1After.childIds.length, 1);
  const newId = r1After.childIds[0];
  const newTaxon = await getTaxonRecord(app, newId);
  assert.equal(newTaxon.name, "Fantasy");
  assert.equal(newTaxon.owner, "alice"); // ownership transfer §5/§12.1
  assert.deepEqual(newTaxon.parentIds, [r1]);

  // Alice's queue is empty now.
  assert.equal((await queueOf(app, "alice")).length, 0);

  // Status reflects accepted.
  const status = await app.request(`/proposals/${sub.id}`);
  const body = (await status.json()) as { payload: { children: { disposition: string }[] } };
  assert.equal(body.payload.children[0].disposition, "accepted");
});

test("accept add-graft: edge added, grafted taxon stays owned by original owner (§9.3)", async () => {
  const app = await freshApp();
  await register(app, "erin");
  await register(app, "frank");
  await register(app, "grace");
  // Frank's tree: b1 → b2.
  const b1 = (await createTaxon(app, "frank", "Genre Index")).id;
  const b2 = (await createTaxon(app, "frank", "Dark Fiction")).id;
  await attach(app, "frank", b1, b2);
  // Erin's separate root: a3 (its own tree).
  const a3 = (await createTaxon(app, "erin", "Psychological Thriller")).id;

  const sub = await submitOk(app, "grace", {
    targetRootId: b1,
    topTaxonId: b1,
    payload: {
      op: "no-op",
      id: b1,
      children: [
        { op: "no-op", id: b2, children: [{ op: "add", id: a3 }] },
      ],
    },
  });
  const graftChangeId = sub.payload.children![0].children![0].changeId!;

  // Frank reviews the graft.
  await acceptOk(app, "frank", graftChangeId);

  // a3 is now a child of b2 in T2.
  const b2After = await getTaxonRecord(app, b2);
  assert.ok(b2After.childIds.includes(a3));

  // a3 is now shared: still a root (its original tree's root), now also
  // reachable via b2/b1. Parents of a3 = [b2] (it had no parents before).
  const a3After = await getTaxonRecord(app, a3);
  assert.equal(a3After.owner, "erin"); // §9.3 — graft preserves ownership
  assert.deepEqual(a3After.parentIds, [b2]);

  // Frank's queue empty.
  assert.equal((await queueOf(app, "frank")).length, 0);
});

test("accept detach: edge removed, detached child survives", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Fantasy")).id;
  await attach(app, "alice", r1, c1);

  const sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "detach", id: c1 }],
    },
  });
  const changeId = sub.payload.children![0].changeId!;

  await acceptOk(app, "alice", changeId);

  // r1 has no children now.
  const r1After = await getTaxonRecord(app, r1);
  assert.equal(r1After.childIds.length, 0);
  // c1 survives, is now a root.
  const c1After = await getTaxonRecord(app, c1);
  assert.deepEqual(c1After.parentIds, []);
  assert.equal(c1After.name, "Fantasy");

  const trees = await app.request("/trees");
  const treeBody = (await trees.json()) as { trees: { id: string }[] };
  assert.ok(treeBody.trees.some((t) => t.id === r1));
  assert.ok(treeBody.trees.some((t) => t.id === c1));
});
