// Phase 7 — end-to-end integration covering the §13 matrix and the
// §14 accepted-properties keystones via complete multi-actor scenarios.
// Builds on Phase 6's reviewIntegration.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  acceptCascadeOk,
  acceptOk,
  attach,
  createTaxon,
  dismissOk,
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

async function detachEdge(
  app: App,
  caller: string,
  parentId: string,
  childId: string,
) {
  const res = await app.request(`/taxa/${parentId}/children/${childId}`, {
    method: "DELETE",
    headers: { "X-Username": caller },
  });
  assert.equal(res.status, 204);
}

async function reassignOwner(
  app: App,
  caller: string,
  taxonId: string,
  newOwner: string,
) {
  const res = await app.request(`/taxa/${taxonId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Username": caller },
    body: JSON.stringify({ owner: newOwner }),
  });
  assert.equal(res.status, 200);
}

async function deleteTaxon(app: App, caller: string, taxonId: string) {
  const res = await app.request(`/taxa/${taxonId}`, {
    method: "DELETE",
    headers: { "X-Username": caller },
  });
  return res;
}

// --- Appendix A.1 via cascade --------------------------------------------

test("Appendix A.1 end-to-end via accept-cascade", async () => {
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

  const sub = await submitOk(app, "carol", {
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
  const ufId = sub.payload.children![0].children![0].children![1].changeId!;

  // Bob cascade-accepts the Urban Fantasy create. The cascade extends
  // to Paranormal Romance (Bob owns the new UF). Then Bob accepts the
  // c3 rename. Then Alice accepts the c1 rename.
  await acceptCascadeOk(app, "bob", ufId);
  const c3RenameId = sub.payload.children![0].children![0].children![0].changeId!;
  const c1RenameId = sub.payload.children![0].changeId!;
  await acceptOk(app, "bob", c3RenameId);
  await acceptOk(app, "alice", c1RenameId);

  assert.equal((await getTaxon(app, c1)).name, "Speculative and Imaginative Fiction");
  assert.equal((await getTaxon(app, c3)).name, "High Fantasy");
  const c2After = await getTaxon(app, c2);
  assert.equal(c2After.childIds.length, 2);
});

// --- Appendix A.2 in full -------------------------------------------------

test("Appendix A.2 end-to-end with case-3 invalidation and dismiss", async () => {
  const app = await freshApp();
  await register(app, "dana");
  await register(app, "erin");
  await register(app, "frank");
  await register(app, "grace");
  const a1 = (await createTaxon(app, "dana", "Suspense and Discovery Fiction")).id;
  const a2 = (await createTaxon(app, "dana", "Thriller")).id;
  const a3 = (await createTaxon(app, "erin", "Psychological Thriller")).id;
  await attach(app, "dana", a1, a2);
  await attach(app, "dana", a2, a3);
  const b1 = (await createTaxon(app, "frank", "Genre Index")).id;
  const b2 = (await createTaxon(app, "frank", "Dark Fiction")).id;
  await attach(app, "frank", b1, b2);

  const p1 = await submitOk(app, "grace", {
    targetRootId: a1,
    topTaxonId: a1,
    payload: {
      op: "no-op",
      id: a1,
      children: [
        { op: "no-op", id: a2, children: [{ op: "detach", id: a3 }] },
      ],
    },
  });
  const p1DetachId = p1.payload.children![0].children![0].changeId!;
  const p2 = await submitOk(app, "grace", {
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
  const p2GraftId = p2.payload.children![0].children![0].changeId!;
  const p2InnerId =
    p2.payload.children![0].children![0].children![0].changeId!;

  // Step 1: Frank accepts the graft.
  await acceptOk(app, "frank", p2GraftId);
  // Step 2: Dana rejects the detach.
  await rejectOk(app, "dana", p1DetachId);
  // Step 3: Frank directly detaches a3 from b2 — externally invalidates
  // the queued inner create.
  await detachEdge(app, "frank", b2, a3);

  // Erin's queue now shows the inner create as case-3 invalid.
  const erinQ = await queueOf(app, "erin");
  const innerEntry = erinQ.find((e) => e.changeId === p2InnerId);
  assert.ok(innerEntry);
  assert.equal(innerEntry?.state, "invalid");
  const p2Status = walkStatusNodes(await statusFor(app, p2.id));
  assert.equal(p2Status.find((n) => n.changeId === p2InnerId)?.disposition, "invalid");

  // Erin dismisses. Final live state matches A.2 (a3 only under a2).
  await dismissOk(app, "erin", p2InnerId);
  const a3After = await getTaxon(app, a3);
  assert.deepEqual(a3After.parentIds, [a2]);
  const erinQAfter = await queueOf(app, "erin");
  assert.ok(!erinQAfter.some((e) => e.changeId === p2InnerId));
});

// --- §14 bullet 2 — collaborative deletion --------------------------------

test("§14 collaborative deletion: U-owned shared taxon blocks delete until detached via proposals", async () => {
  const app = await freshApp();
  await register(app, "dana");
  await register(app, "frank");
  // Dana owns r1 with child shared, then a sub-child leaf. Frank owns r2.
  // Dana also attaches shared under r2 (via a proposal to Frank? No — Dana
  // owns the shared taxon and Frank owns the parent r2; the §6.4 edge-add
  // is owner-of-parent-controlled, so only Frank can attach shared as
  // child of r2). We'll simulate this by having Frank accept a graft
  // proposal from Dana.
  const r1 = (await createTaxon(app, "dana", "Dana Root")).id;
  const shared = (await createTaxon(app, "dana", "Shared")).id;
  const leaf = (await createTaxon(app, "dana", "Leaf")).id;
  await attach(app, "dana", r1, shared);
  await attach(app, "dana", shared, leaf);
  const r2 = (await createTaxon(app, "frank", "Frank Root")).id;
  // Dana proposes graft of `shared` under r2. Frank reviews.
  const sub1 = await submitOk(app, "dana", {
    targetRootId: r2,
    topTaxonId: r2,
    payload: {
      op: "no-op",
      id: r2,
      children: [{ op: "add", id: shared }],
    },
  });
  await acceptOk(app, "frank", sub1.payload.children![0].changeId!);
  // shared now reachable from both r1 and r2.

  // Dana tries to delete r1's subtree (which contains shared). Should
  // fail because shared is shared (precondition 1 of §6.3).
  const res = await deleteTaxon(app, "dana", r1);
  assert.equal(res.status, 409);

  // Dana proposes detach of shared from r2 — routes to Frank.
  const sub2 = await submitOk(app, "dana", {
    targetRootId: r2,
    topTaxonId: r2,
    payload: {
      op: "no-op",
      id: r2,
      children: [{ op: "detach", id: shared }],
    },
  });
  await acceptOk(app, "frank", sub2.payload.children![0].changeId!);

  // Now shared is only under r1; Dana can delete the region.
  const res2 = await deleteTaxon(app, "dana", r1);
  assert.equal(res2.status, 204);
});

// --- §14 bullet 3 — ownership reassignment reroutes promotion -------------

test("§14 ownership reassignment reroutes promotion-time reviewer", async () => {
  // Latent rename under an add-create. The rename's reviewer is the
  // renamed taxon's owner — re-resolved at promotion time. Reassign
  // ownership between submission and the parent's acceptance; the
  // promoted rename should route to the NEW owner, demonstrating the
  // §6.2 unilateral reassignment flowing into promotion-time routing.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Root")).id;
  const t = (await createTaxon(app, "alice", "Anchor")).id;
  await attach(app, "alice", r1, t);

  // Carol's proposal: under r1, add-create "Wrapper"; under Wrapper, a
  // rename of t. The rename is latent (decision-dep on Wrapper).
  const sub = await submitOk(app, "carol", {
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
          children: [{ op: "rename", id: t, name: "RenamedAnchor" }],
        },
      ],
    },
  });
  const wrapperId = sub.payload.children![0].changeId!;
  const renameId = sub.payload.children![0].children![0].changeId!;

  // Reassign ownership of t from Alice to Bob.
  await reassignOwner(app, "alice", t, "bob");

  // Alice accepts Wrapper. Promotion of the rename re-resolves the
  // reviewer from live state — t's owner is Bob now.
  await acceptOk(app, "alice", wrapperId);
  const bobQ = await queueOf(app, "bob");
  assert.ok(
    bobQ.some((e) => e.changeId === renameId && e.state === "queued"),
    "Rename should be in Bob's queue (new owner of t)",
  );
  const aliceQ = await queueOf(app, "alice");
  assert.ok(
    !aliceQ.some((e) => e.changeId === renameId),
    "Rename should NOT be in Alice's queue (old owner of t)",
  );
});

// --- §14 bullet 4 — cascade-delete detaches and invalidates --------------

test("§14 cascade-delete halts at other-owned; queued change under detached taxon becomes case-3 invalid", async () => {
  // Dana owns r1 -> midD -> midE (Erin) -> leafD (Dana). midD is Dana,
  // midE is Erin. Dana deletes r1 (Dana's region): r1, midD, leafD
  // would all be Dana — but the cascade halts at midE (Erin's), so midE
  // detaches from midD. leafD survives — it's under midE, which is now
  // detached.
  //
  // Now Grace had a queued change under midE (rename of leafD, say —
  // routes to Dana since leafD is Dana's). After the cascade-delete,
  // leafD is no longer in r1's tree (because midE detached). The
  // rename's existence-deps no longer hold (the rename anchors at r1).
  // On Dana's next /queue read, the rename is case-3 invalid.
  const app = await freshApp();
  await register(app, "dana");
  await register(app, "erin");
  await register(app, "grace");
  const r1 = (await createTaxon(app, "dana", "Dana Root")).id;
  const midD = (await createTaxon(app, "dana", "MidD")).id;
  const midE = (await createTaxon(app, "erin", "MidE")).id;
  const leafD = (await createTaxon(app, "dana", "LeafD")).id;
  await attach(app, "dana", r1, midD);
  await attach(app, "dana", midD, midE);
  await attach(app, "erin", midE, leafD);

  const sub = await submitOk(app, "grace", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        {
          op: "no-op",
          id: midD,
          children: [
            {
              op: "no-op",
              id: midE,
              children: [
                { op: "rename", id: leafD, name: "RenamedLeaf" },
              ],
            },
          ],
        },
      ],
    },
  });
  const renameId =
    sub.payload.children![0].children![0].children![0].changeId!;

  // Dana's queue has the rename initially.
  const danaQBefore = await queueOf(app, "dana");
  assert.ok(danaQBefore.some((e) => e.changeId === renameId));

  // Dana deletes r1: cascade hits midE (Erin's) and halts. midE
  // detaches from midD; midD and r1 are deleted.
  const delRes = await deleteTaxon(app, "dana", r1);
  assert.equal(delRes.status, 204);

  // Dana's queue read → rename is case-3 invalid.
  const danaQAfter = await queueOf(app, "dana");
  const entry = danaQAfter.find((e) => e.changeId === renameId);
  assert.ok(entry);
  assert.equal(entry?.state, "invalid");
});

// --- Reset across Phase-7 lifecycle ---------------------------------------

test("reset across Phase-7 lifecycle: clears cascade, case-3 invalid, and case-2 auto-dismissed state", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const fantasy = (await createTaxon(app, "alice", "Fantasy")).id;
  const mystery = (await createTaxon(app, "alice", "Mystery")).id;
  await attach(app, "alice", r1, fantasy);
  await attach(app, "alice", r1, mystery);

  // 1. Cascade-acceptable proposal.
  const cSub = await submitOk(app, "bob", {
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
  await acceptCascadeOk(app, "alice", cSub.payload.children![0].changeId!);

  // 2. Case-3 invalid queued change.
  const c3Sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: mystery, name: "Goal" }],
    },
  });
  // Alice creates another sibling "Goal" to force case-3 on her own
  // queue via lazy detection.
  const goal = (await createTaxon(app, "alice", "Goal")).id;
  await attach(app, "alice", r1, goal);
  await queueOf(app, "alice"); // trigger lazy

  // 3. Case-2 auto-dismissed.
  const c2Sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: fantasy, name: "Goal" }],
    },
  });
  await app.request(`/changes/${c2Sub.payload.children![0].changeId!}/accept`, {
    method: "POST",
    headers: { "X-Username": "alice" },
  });

  // Reset.
  const reset = await app.request("/reset", { method: "POST" });
  assert.equal(reset.status, 204);

  // Everything is gone.
  const usersRes = await app.request("/users");
  assert.deepEqual((await usersRes.json()) as { users: string[] }, { users: [] });
  const taxaRes = await app.request("/taxa");
  assert.deepEqual((await taxaRes.json()) as { taxa: unknown[] }, { taxa: [] });
  const proposalsRes = await app.request("/proposals");
  assert.deepEqual(
    (await proposalsRes.json()) as { proposals: unknown[] },
    { proposals: [] },
  );

  // Re-register and create — fresh id counters.
  await register(app, "alice");
  const fresh = await createTaxon(app, "alice", "FreshFiction");
  assert.equal(fresh.id, "t1", "id counter should reset");
});
