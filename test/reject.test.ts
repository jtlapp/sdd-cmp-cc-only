// Phase-6 §12.3 reject + §11.4 case 1 propagation. Decision #1 filter:
// only add/graft rejection cascades-invalidates descendants. Rename
// rejection leaves descendants alone (they have an existence dep on the
// renamed taxon, not a decision dep on the rename).

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
  rejectOk,
  submitOk,
  type App,
  type StatusNode,
  walkStatusNodes,
} from "./proposalsTestHelpers.js";

async function queueOf(app: App, who: string): Promise<QueueEntry[]> {
  const res = await getQueue(app, who);
  return ((await res.json()) as { changes: QueueEntry[] }).changes;
}

async function statusFor(app: App, proposalId: string): Promise<StatusNode> {
  const res = await app.request(`/proposals/${proposalId}`);
  const body = (await res.json()) as { payload: StatusNode };
  return body.payload;
}

async function getTaxonRecord(app: App, id: string) {
  const res = await app.request(`/taxa/${id}`);
  assert.equal(res.status, 200);
  return (await res.json()) as { name: string; childIds: string[] };
}

test("reject rename: change marked rejected, live name unchanged, dequeued", async () => {
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

  const ack = await rejectOk(app, "alice", changeId);
  assert.deepEqual(ack, { changeId, state: "rejected" });

  assert.equal((await getTaxonRecord(app, r1)).name, "Fiction");
  assert.equal((await queueOf(app, "alice")).length, 0);
  const status = walkStatusNodes(await statusFor(app, sub.id));
  assert.equal(status[0].disposition, "rejected");
});

test("reject detach: edge survives, no descendants to worry about", async () => {
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

  await rejectOk(app, "alice", changeId);
  // Edge still there.
  assert.deepEqual((await getTaxonRecord(app, r1)).childIds, [c1]);
});

test("reject add-create with no nested ops: state goes rejected, no taxon created", async () => {
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

  await rejectOk(app, "alice", changeId);
  assert.deepEqual((await getTaxonRecord(app, r1)).childIds, []);
});

test("reject add-create with nested create: outer rejected, inner invalid with reason citing outer", async () => {
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
      children: [
        {
          op: "add",
          id: null,
          name: "Urban Fantasy",
          children: [{ op: "add", id: null, name: "Paranormal Romance" }],
        },
      ],
    },
  });
  const outerId = sub.payload.children![0].changeId!;
  const innerId = sub.payload.children![0].children![0].changeId!;

  await rejectOk(app, "alice", outerId);

  const status = walkStatusNodes(await statusFor(app, sub.id));
  const outerStatus = status.find((n) => n.changeId === outerId);
  const innerStatus = status.find((n) => n.changeId === innerId);
  assert.equal(outerStatus?.disposition, "rejected");
  assert.equal(innerStatus?.disposition, "invalid");
  assert.match(innerStatus?.reason ?? "", new RegExp(outerId));
  // The inner change was never in any queue; r1 still has no children.
  assert.deepEqual((await getTaxonRecord(app, r1)).childIds, []);
});

test("reject add-graft with mixed nested ops: all descendants invalidated", async () => {
  const app = await freshApp();
  await register(app, "erin");
  await register(app, "frank");
  await register(app, "grace");
  const a3 = (await createTaxon(app, "erin", "Psychological Thriller")).id;
  const a3c = (await createTaxon(app, "erin", "Locked-Room Mystery")).id;
  await attach(app, "erin", a3, a3c);
  const b1 = (await createTaxon(app, "frank", "Genre Index")).id;
  const b2 = (await createTaxon(app, "frank", "Dark Fiction")).id;
  await attach(app, "frank", b1, b2);

  const sub = await submitOk(app, "grace", {
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
                { op: "rename", id: a3c, name: "Country-House Mystery" },
                { op: "detach", id: a3c },
              ],
            },
          ],
        },
      ],
    },
  });
  const graftId = sub.payload.children![0].children![0].changeId!;
  const innerCreateId = sub.payload.children![0].children![0].children![0].changeId!;
  const innerRenameId = sub.payload.children![0].children![0].children![1].changeId!;
  const innerDetachId = sub.payload.children![0].children![0].children![2].changeId!;

  await rejectOk(app, "frank", graftId);

  const status = walkStatusNodes(await statusFor(app, sub.id));
  assert.equal(status.find((n) => n.changeId === graftId)?.disposition, "rejected");
  for (const id of [innerCreateId, innerRenameId, innerDetachId]) {
    const s = status.find((n) => n.changeId === id);
    assert.equal(s?.disposition, "invalid", `expected ${id} invalid`);
    assert.match(s?.reason ?? "", new RegExp(graftId));
  }
});

test("multi-level cascade: rejecting an outer add invalidates ALL nested descendants", async () => {
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
              children: [{ op: "rename", id: r1, name: "Renamed Fiction" }],
            },
          ],
        },
      ],
    },
  });
  const aId = sub.payload.children![0].changeId!;
  const bId = sub.payload.children![0].children![0].changeId!;
  const renameId = sub.payload.children![0].children![0].children![0].changeId!;

  await rejectOk(app, "alice", aId);

  const status = walkStatusNodes(await statusFor(app, sub.id));
  assert.equal(status.find((n) => n.changeId === aId)?.disposition, "rejected");
  assert.equal(status.find((n) => n.changeId === bId)?.disposition, "invalid");
  assert.equal(status.find((n) => n.changeId === renameId)?.disposition, "invalid");
});

test("reject of a rename DOES NOT invalidate its descendants (decision #1 keystone)", async () => {
  // top no-op anchor; nested rename of c1 (Alice's); under the rename,
  // a nested add-create. The nested create is QUEUED at submission
  // (rename is an existence dep, not a decision dep). Rejecting the
  // rename must NOT touch the nested create.
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
      children: [
        {
          op: "rename",
          id: c1,
          name: "Speculative Fantasy",
          children: [{ op: "add", id: null, name: "Urban Fantasy" }],
        },
      ],
    },
  });
  const renameId = sub.payload.children![0].changeId!;
  const innerCreateId = sub.payload.children![0].children![0].changeId!;

  // Pre: inner add is queued (no decision-dep ancestor — rename is
  // existence-only).
  let status = walkStatusNodes(await statusFor(app, sub.id));
  assert.equal(status.find((n) => n.changeId === innerCreateId)?.disposition, "queued");

  await rejectOk(app, "alice", renameId);

  status = walkStatusNodes(await statusFor(app, sub.id));
  assert.equal(status.find((n) => n.changeId === renameId)?.disposition, "rejected");
  // Inner is UNCHANGED — still queued.
  assert.equal(status.find((n) => n.changeId === innerCreateId)?.disposition, "queued");
  const aliceQ = await queueOf(app, "alice");
  assert.ok(aliceQ.some((e) => e.changeId === innerCreateId));
});

test("reject of a detach: detach has no children so propagation is moot; siblings untouched", async () => {
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
      children: [
        { op: "detach", id: c1 },
        { op: "add", id: null, name: "Mystery" },
      ],
    },
  });
  const detachId = sub.payload.children![0].changeId!;
  const siblingAddId = sub.payload.children![1].changeId!;

  await rejectOk(app, "alice", detachId);
  // Sibling add is still queued, untouched.
  const status = walkStatusNodes(await statusFor(app, sub.id));
  assert.equal(status.find((n) => n.changeId === detachId)?.disposition, "rejected");
  assert.equal(status.find((n) => n.changeId === siblingAddId)?.disposition, "queued");
});
