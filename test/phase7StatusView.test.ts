// Phase 7 — §11.5 / §15.2 projections for the new states.
//
//   - Proposer status view shows `invalid` for all three §11.4 cases,
//     never distinguishing case 2 (auto-dismissed) from case 3
//     (awaiting dismiss).
//   - /queue includes case-3 invalid entries (state="invalid"), but not
//     case-1 or case-2 invalids (those aren't queued).
//   - After a successful cascade, the reviewer's queue is clean of the
//     cascade's accepted set.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  acceptCascadeOk,
  acceptOk,
  attach,
  createTaxon,
  freshApp,
  getQueue,
  QueueEntry,
  register,
  rejectOk,
  StatusNode,
  submitOk,
  walkStatusNodes,
  type App,
} from "./proposalsTestHelpers.js";

async function queueOf(app: App, who: string): Promise<QueueEntry[]> {
  const res = await getQueue(app, who);
  return ((await res.json()) as { changes: QueueEntry[] }).changes;
}

async function statusFor(app: App, proposalId: string): Promise<StatusNode> {
  const res = await app.request(`/proposals/${proposalId}`);
  return ((await res.json()) as { payload: StatusNode }).payload;
}

async function renameTaxon(
  app: App,
  caller: string,
  taxonId: string,
  newName: string,
) {
  const res = await app.request(`/taxa/${taxonId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Username": caller },
    body: JSON.stringify({ name: newName }),
  });
  assert.equal(res.status, 200);
}

test("proposer view shows `invalid` for all three §11.4 cases, identically", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const fantasy = (await createTaxon(app, "alice", "Fantasy")).id;
  const mystery = (await createTaxon(app, "alice", "Mystery")).id;
  await attach(app, "alice", r1, fantasy);
  await attach(app, "alice", r1, mystery);

  // Case 1: rejection-propagation. Add-create with a nested rename;
  // reject the add → rename becomes case-1 invalid.
  const sub1 = await submitOk(app, "carol", {
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
          children: [{ op: "rename", id: fantasy, name: "Speculative Fantasy" }],
        },
      ],
    },
  });
  const sub1OuterId = sub1.payload.children![0].changeId!;
  const sub1InnerId = sub1.payload.children![0].children![0].changeId!;
  await rejectOk(app, "alice", sub1OuterId);

  // Case 2: failed accept (auto-dismiss).
  const sub2 = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: mystery, name: "Fantasy" }],
    },
  });
  const sub2Id = sub2.payload.children![0].changeId!;
  await app.request(`/changes/${sub2Id}/accept`, {
    method: "POST",
    headers: { "X-Username": "alice" },
  });

  // Case 3: external invalidation.
  const sub3 = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: mystery, name: "Target3" }],
    },
  });
  // wait — mystery is already invalid for sub2 above. But that doesn't
  // matter; sub3 is a SEPARATE change. After sub2 auto-dismissed,
  // mystery still exists with name "Mystery". Sub3 wants to rename it
  // to "Target3". For case 3, Alice externally creates "Target3" as a
  // sibling.
  const target3 = (await createTaxon(app, "alice", "Target3")).id;
  await attach(app, "alice", r1, target3);
  // Alice reads /queue → sub3's change transitions to case-3 invalid.
  await queueOf(app, "alice");

  // All three proposer views show `invalid` for their respective change.
  const s1Inner = walkStatusNodes(await statusFor(app, sub1.id)).find(
    (n) => n.changeId === sub1InnerId,
  );
  assert.equal(s1Inner?.disposition, "invalid");
  const s2 = walkStatusNodes(await statusFor(app, sub2.id)).find(
    (n) => n.changeId === sub2Id,
  );
  assert.equal(s2?.disposition, "invalid");
  const sub3Id = sub3.payload.children![0].changeId!;
  const s3 = walkStatusNodes(await statusFor(app, sub3.id)).find(
    (n) => n.changeId === sub3Id,
  );
  assert.equal(s3?.disposition, "invalid");

  // The status view does NOT expose which case it is via disposition;
  // only the reason string differentiates them.
  // (Reason strings are validated in invalidation.test.ts; here we just
  // confirm the dispositions are uniform.)
});

test("/queue includes case-3 invalid entries but NOT case-1 / case-2", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const fantasy = (await createTaxon(app, "alice", "Fantasy")).id;
  const mystery = (await createTaxon(app, "alice", "Mystery")).id;
  await attach(app, "alice", r1, fantasy);
  await attach(app, "alice", r1, mystery);

  // Case 1 setup.
  const sub1 = await submitOk(app, "bob", {
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
          children: [{ op: "rename", id: fantasy, name: "X" }],
        },
      ],
    },
  });
  await rejectOk(app, "alice", sub1.payload.children![0].changeId!);
  const sub1InnerId = sub1.payload.children![0].children![0].changeId!;

  // Case 2 setup.
  const sub2 = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: mystery, name: "Fantasy" }],
    },
  });
  const sub2Id = sub2.payload.children![0].changeId!;
  await app.request(`/changes/${sub2Id}/accept`, {
    method: "POST",
    headers: { "X-Username": "alice" },
  });

  // Case 3 setup.
  const sub3 = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: mystery, name: "Target3" }],
    },
  });
  const target3 = (await createTaxon(app, "alice", "Target3")).id;
  await attach(app, "alice", r1, target3);
  const aliceQ = await queueOf(app, "alice");

  // Case 3 IS present; case 1 + case 2 are not.
  const sub3Id = sub3.payload.children![0].changeId!;
  assert.ok(aliceQ.some((e) => e.changeId === sub3Id && e.state === "invalid"));
  assert.ok(!aliceQ.some((e) => e.changeId === sub2Id));
  assert.ok(!aliceQ.some((e) => e.changeId === sub1InnerId));
});

test("successful cascade leaves queue clean of the cascade's accepted set", async () => {
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
              children: [{ op: "add", id: null, name: "C" }],
            },
          ],
        },
      ],
    },
  });
  const aId = sub.payload.children![0].changeId!;
  const bId = sub.payload.children![0].children![0].changeId!;
  const cId = sub.payload.children![0].children![0].children![0].changeId!;

  const r = await acceptCascadeOk(app, "alice", aId);
  assert.deepEqual(r.acceptedChangeIds, [aId, bId, cId]);

  const aliceQ = await queueOf(app, "alice");
  for (const id of [aId, bId, cId]) {
    assert.ok(!aliceQ.some((e) => e.changeId === id),
      `cascade-accepted ${id} should not remain in queue`);
  }
});
