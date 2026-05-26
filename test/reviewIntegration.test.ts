// Phase-6 end-to-end integration: full multi-step walkthroughs combining
// accepts, rejects, and direct actions across multiple reviewers and
// trees. Covers Appendix A.1 (single-accepts replacing the cascade) and
// A.2 (graft + reject-detach, leaving a shared taxon).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  acceptChange,
  acceptOk,
  attach,
  createTaxon,
  ErrorBody,
  freshApp,
  getQueue,
  listProposals,
  QueueEntry,
  register,
  rejectChange,
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
  return (await res.json()) as { id: string; name: string; owner: string; childIds: string[]; parentIds: string[] };
}

// --- Appendix A.1 walkthrough via single-accepts only ----------------------

test("Appendix A.1: full walkthrough using single accepts (no cascade)", async () => {
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
                  children: [{ op: "add", id: null, name: "Paranormal Romance" }],
                },
              ],
            },
          ],
        },
      ],
    },
  });
  const c1RenameId = sub.payload.children![0].changeId!;
  const c3RenameId = sub.payload.children![0].children![0].children![0].changeId!;
  const ufId = sub.payload.children![0].children![0].children![1].changeId!;
  const prId = sub.payload.children![0].children![0].children![1].children![0].changeId!;

  // 1. Bob accepts c3 rename.
  await acceptOk(app, "bob", c3RenameId);
  assert.equal((await getTaxonRecord(app, c3)).name, "High Fantasy");

  // 2. Bob accepts Urban Fantasy create → new taxon owned by Bob.
  await acceptOk(app, "bob", ufId);
  const c2After = await getTaxonRecord(app, c2);
  const ufId_live = c2After.childIds.find((id) => id !== c3)!;
  const ufRecord = await getTaxonRecord(app, ufId_live);
  assert.equal(ufRecord.name, "Urban Fantasy");
  assert.equal(ufRecord.owner, "bob");

  // 3. Paranormal Romance should now be queued (to Bob, the new owner of UF).
  const bobQ = await queueOf(app, "bob");
  assert.ok(bobQ.some((e) => e.changeId === prId));

  // 4. Bob accepts Paranormal Romance.
  await acceptOk(app, "bob", prId);
  const ufAfter = await getTaxonRecord(app, ufId_live);
  assert.equal(ufAfter.childIds.length, 1);
  const prRecord = await getTaxonRecord(app, ufAfter.childIds[0]);
  assert.equal(prRecord.name, "Paranormal Romance");
  assert.equal(prRecord.owner, "bob");

  // 5. Alice accepts c1 rename.
  await acceptOk(app, "alice", c1RenameId);
  assert.equal((await getTaxonRecord(app, c1)).name, "Speculative and Imaginative Fiction");

  // Status: every operative node is accepted; no-op nodes are structural.
  const status = walkStatusNodes(await statusFor(app, sub.id));
  for (const n of status) {
    if (n.op === "no-op") assert.equal(n.disposition, "structural");
    else assert.equal(n.disposition, "accepted", `expected ${n.changeId} accepted`);
  }
});

test("Appendix A.1: variant where Alice accepts c1 rename first", async () => {
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
                { op: "add", id: null, name: "Urban Fantasy" },
              ],
            },
          ],
        },
      ],
    },
  });
  const c1RenameId = sub.payload.children![0].changeId!;
  const c3RenameId = sub.payload.children![0].children![0].children![0].changeId!;
  const ufId = sub.payload.children![0].children![0].children![1].changeId!;

  // c1 rename first.
  await acceptOk(app, "alice", c1RenameId);
  await acceptOk(app, "bob", c3RenameId);
  await acceptOk(app, "bob", ufId);

  // c1 was renamed; rename of c1 doesn't disturb c2's parentage so the
  // nested ops are still valid.
  assert.equal((await getTaxonRecord(app, c1)).name, "Speculative and Imaginative Fiction");
  assert.equal((await getTaxonRecord(app, c3)).name, "High Fantasy");
  const c2After = await getTaxonRecord(app, c2);
  assert.equal(c2After.childIds.length, 2);
});

// --- Appendix A.2 partial walkthrough -------------------------------------

test("Appendix A.2: graft accept + detach reject leaves taxon shared across trees", async () => {
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
              children: [{ op: "add", id: null, name: "Unreliable Narrator Thriller" }],
            },
          ],
        },
      ],
    },
  });
  const p2GraftId = p2.payload.children![0].children![0].changeId!;
  const p2InnerId = p2.payload.children![0].children![0].children![0].changeId!;

  // Frank accepts the graft → a3 is shared (under both a2 and b2);
  // ownership unchanged (Erin); inner create promotes to Erin's queue.
  await acceptOk(app, "frank", p2GraftId);
  const a3After = await getTaxonRecord(app, a3);
  assert.deepEqual(a3After.parentIds.sort(), [a2, b2].sort());
  assert.equal(a3After.owner, "erin");
  const erinQ = await queueOf(app, "erin");
  assert.ok(erinQ.some((e) => e.changeId === p2InnerId));

  // Dana rejects P1's detach → live state unchanged; a3 stays under a2.
  await rejectOk(app, "dana", p1DetachId);
  const a2After = await getTaxonRecord(app, a2);
  assert.ok(a2After.childIds.includes(a3));
  // The two proposals are independent — P2 unaffected.
  const p2Status = walkStatusNodes(await statusFor(app, p2.id));
  assert.equal(p2Status.find((n) => n.changeId === p2GraftId)?.disposition, "accepted");
  assert.equal(p2Status.find((n) => n.changeId === p2InnerId)?.disposition, "queued");

  // Erin's queue still contains the inner create (it stays queued in
  // Phase 6; Phase 7's external-invalidation-on-detach behavior will
  // mark it invalid-pending-dismiss).
  const erinQAfter = await queueOf(app, "erin");
  assert.ok(erinQAfter.some((e) => e.changeId === p2InnerId));
});

// --- Acceptance failure does not leave residue ----------------------------

test("failed accept does not mutate live state; change transitions to invalid (§11.4 case 2)", async () => {
  // Phase 7 replaces Phase 6's placeholder: failed accept now
  // auto-dismisses the change (case 2). Live state remains byte-equal
  // to pre-call. A subsequent reject is therefore a no-op on a
  // non-queued change — returns 409 change_not_queued with state
  // "invalid".
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const fantasy = (await createTaxon(app, "alice", "Fantasy")).id;
  const mystery = (await createTaxon(app, "alice", "Mystery")).id;
  await attach(app, "alice", r1, fantasy);
  await attach(app, "alice", r1, mystery);

  const sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: mystery, name: "Fantasy" }],
    },
  });
  const changeId = sub.payload.children![0].changeId!;

  // Fail.
  const fail = await acceptChange(app, "alice", changeId);
  assert.equal(fail.status, 409);
  const failBody = (await fail.json()) as ErrorBody;
  assert.equal(failBody.error.code, "conflict");
  assert.equal(failBody.error.details?.kind, "name_clash");

  // State unchanged.
  assert.equal((await getTaxonRecord(app, mystery)).name, "Mystery");

  // Change is auto-dismissed (case 2): invalid + gone from Alice's queue.
  const status = walkStatusNodes(await statusFor(app, sub.id));
  assert.equal(status.find((n) => n.changeId === changeId)?.disposition, "invalid");
  const aliceQ = await queueOf(app, "alice");
  assert.ok(!aliceQ.some((e) => e.changeId === changeId));

  // Subsequent reject attempt returns 409 (change no longer queued).
  const rejectRes = await rejectChange(app, "alice", changeId);
  assert.equal(rejectRes.status, 409);
  const rejectBody = (await rejectRes.json()) as ErrorBody;
  assert.equal(rejectBody.error.details?.kind, "change_not_queued");
  assert.equal(rejectBody.error.details?.state, "invalid");
});

// --- Cross-tree shared-taxon rename -----------------------------------------

test("rename of a shared taxon propagates to both trees on accept", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const r2 = (await createTaxon(app, "alice", "Genre Index")).id;
  const shared = (await createTaxon(app, "alice", "Fantasy")).id;
  await attach(app, "alice", r1, shared);
  await attach(app, "alice", r2, shared);

  const sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: shared, name: "Speculative Fiction" }],
    },
  });
  const changeId = sub.payload.children![0].changeId!;
  await acceptOk(app, "alice", changeId);

  // Both trees see the rename.
  const tree1 = (await (await app.request(`/trees/${r1}`)).json()) as {
    children: { id: string; name?: string }[];
  };
  const tree2 = (await (await app.request(`/trees/${r2}`)).json()) as {
    children: { id: string; name?: string }[];
  };
  assert.equal(tree1.children.find((c) => c.id === shared)?.name, "Speculative Fiction");
  assert.equal(tree2.children.find((c) => c.id === shared)?.name, "Speculative Fiction");
});

// --- Self-routed accept ---------------------------------------------------

test("self-routed accept: proposer accepts her own change", async () => {
  const app = await freshApp();
  await register(app, "alice");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const sub = await submitOk(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "rename", id: r1, name: "Speculative Fiction" },
  });
  const changeId = sub.payload.changeId!;
  await acceptOk(app, "alice", changeId);
  assert.equal((await getTaxonRecord(app, r1)).name, "Speculative Fiction");
});

// --- Reset across the lifecycle including accept/reject -------------------

test("reset clears post-accept and post-reject state", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const sub1 = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        { op: "rename", id: r1, name: "Renamed Fiction" },
        { op: "add", id: null, name: "ToReject" },
      ],
    },
  });
  await acceptOk(app, "alice", sub1.payload.children![0].changeId!);
  await rejectOk(app, "alice", sub1.payload.children![1].changeId!);

  // Reset.
  await app.request("/reset", { method: "POST" });

  // Re-register, re-create, submit again — proposal id and change id
  // start at p1/c1 again.
  await register(app, "alice");
  await register(app, "bob");
  const r1b = (await createTaxon(app, "alice", "Fiction")).id;
  const sub2 = await submitOk(app, "bob", {
    targetRootId: r1b,
    topTaxonId: r1b,
    payload: { op: "rename", id: r1b, name: "Speculative Fiction" },
  });
  assert.equal(sub2.id, sub1.id);
  assert.equal(sub2.payload.changeId, sub1.payload.children![0].changeId);
  // No residue.
  const listRes = await listProposals(app, null);
  const list = (await listRes.json()) as { proposals: { id: string }[] };
  assert.equal(list.proposals.length, 1);
  assert.equal(list.proposals[0].id, sub2.id);
});
