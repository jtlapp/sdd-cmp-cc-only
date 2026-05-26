// Phase 7 — lazy evaluation of validity (§11.4 last paragraph).
//
// Validity is computed at the lazy seams (/queue read; review-action
// entry), not eagerly after every unrelated write. Verifies:
//
// - Unrelated writes don't eagerly transition the change's state.
// - GET /queue surfaces the transition when it fires.
// - Review-action entry surfaces the transition for queued-but-now-
//   invalid changes other than the one being acted on.
// - Successive reads with no intervening mutation are idempotent.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  acceptOk,
  attach,
  createTaxon,
  ErrorBody,
  freshApp,
  getQueue,
  QueueEntry,
  register,
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

test("unrelated writes do NOT eagerly transition a queued change's state — only a lazy seam does", async () => {
  // Alice has a queued rename. Bob (other user) does a bunch of writes
  // on a DIFFERENT tree. Alice's change should remain queued in the
  // proposal status view until Alice actually reads /queue (or
  // attempts an action). The §11.4 last paragraph explicitly demands
  // this.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Spec")).id;
  await attach(app, "alice", r1, c1);

  const sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c1, name: "Speculative Fiction" }],
    },
  });
  const renameId = sub.payload.children![0].changeId!;

  // Bob does a long sequence of unrelated writes on a different tree.
  const r2 = (await createTaxon(app, "bob", "Other Root")).id;
  for (let i = 0; i < 5; i++) {
    await createTaxon(app, "bob", `Other${i}`);
    await app.request(`/taxa/${r2}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Username": "bob" },
      body: JSON.stringify({ name: `Other Root v${i}` }),
    });
  }

  // Alice's change is still queued (no lazy seam fired).
  const status = walkStatusNodes(await statusFor(app, sub.id));
  assert.equal(status.find((n) => n.changeId === renameId)?.disposition, "queued");
});

test("lazy detection on GET /queue: a queued change broken externally surfaces as invalid in queue", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Fantasy")).id;
  const c2 = (await createTaxon(app, "alice", "Mystery")).id;
  await attach(app, "alice", r1, c1);
  await attach(app, "alice", r1, c2);

  // Bob's rename of c2 -> "Target" is queued to Alice.
  const sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c2, name: "Target" }],
    },
  });
  const renameId = sub.payload.children![0].changeId!;

  // Alice directly renames c1 -> "Target" — sets up the clash.
  await renameTaxon(app, "alice", c1, "Target");

  // Alice's GET /queue triggers lazy re-eval; the queued rename now
  // shows as state: "invalid" but is still in the queue.
  const aliceQ = await queueOf(app, "alice");
  const entry = aliceQ.find((e) => e.changeId === renameId);
  assert.ok(entry);
  assert.equal(entry?.state, "invalid");

  // Proposal status view also reflects it.
  const status = walkStatusNodes(await statusFor(app, sub.id));
  assert.equal(status.find((n) => n.changeId === renameId)?.disposition, "invalid");
});

test("lazy detection on review-action entry: case-3 invalidation surfaces for non-targeted queued changes", async () => {
  // Alice has TWO queued changes. One of them (the non-targeted one)
  // is externally invalidated. When Alice tries to act on the OTHER
  // one, the lazy pass at action entry catches the non-targeted case-3
  // invalidation and marks it accordingly.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Root")).id;
  const c1 = (await createTaxon(app, "alice", "Spec")).id;
  const c2 = (await createTaxon(app, "alice", "Other")).id;
  await attach(app, "alice", r1, c1);
  await attach(app, "alice", r1, c2);

  const subA = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c1, name: "RenamedSpec" }],
    },
  });
  const renAId = subA.payload.children![0].changeId!;

  const subB = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c2, name: "Goal" }],
    },
  });
  const renBId = subB.payload.children![0].changeId!;

  // Bob directly creates a sibling "Goal" under r1.
  const goal = (await createTaxon(app, "alice", "Goal")).id;
  await attach(app, "alice", r1, goal);
  // Now renB would clash.

  // Alice acts on the OTHER change (renA, which is independent and
  // still valid). The lazy pass should mark renB as case-3 invalid
  // even though we're not acting on it.
  await acceptOk(app, "alice", renAId);

  // renB is now case-3 invalid (still in queue).
  const aliceQ = await queueOf(app, "alice");
  const entry = aliceQ.find((e) => e.changeId === renBId);
  assert.ok(entry);
  assert.equal(entry?.state, "invalid");
});

test("idempotence: two successive GET /queue with no intervening writes return the same response", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Fantasy")).id;
  const c2 = (await createTaxon(app, "alice", "Mystery")).id;
  await attach(app, "alice", r1, c1);
  await attach(app, "alice", r1, c2);

  const sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c2, name: "Target" }],
    },
  });
  void sub;
  await renameTaxon(app, "alice", c1, "Target");

  const first = await queueOf(app, "alice");
  const second = await queueOf(app, "alice");
  assert.deepEqual(first, second);
});
