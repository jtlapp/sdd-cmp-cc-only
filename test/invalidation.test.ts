// Phase 7 — §11.4 three-mode invalidation.
//
//   case 1 — dependency failure (add/graft was rejected OR became invalid).
//            Phase 6 covered the rejected half; this file adds the
//            became-invalid half plus the multi-level cascade.
//   case 2 — self-invalidation by the reviewer's own action:
//            auto-dismissed (invalid, dequeued).
//   case 3 — external invalidation: marked invalid, kept queued,
//            requires explicit dismiss.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  acceptCascadeOk,
  acceptOk,
  attach,
  createTaxon,
  ErrorBody,
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

async function deleteTaxon(app: App, caller: string, taxonId: string) {
  const res = await app.request(`/taxa/${taxonId}`, {
    method: "DELETE",
    headers: { "X-Username": caller },
  });
  assert.equal(res.status, 204);
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

// --- Case 1 widening: add/graft becoming invalid propagates ---------------

test("§11.4 case 1: an add becoming invalid propagates to its payload descendants", async () => {
  // Build a proposal with an add-create and a nested rename under it.
  // External invalidation breaks the outer add (case 3 makes IT invalid);
  // the nested rename should become case-1 invalid via propagation.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Spec")).id;
  await attach(app, "alice", r1, c1);

  // Bob proposes: under c1, add-create "Wrapper"; under Wrapper, rename
  // c1 (which is c1, owned by Alice — but the rename existence-deps on
  // c1 being reachable from r1, which holds).
  //
  // Use a different shape: make the outer add fail with case-3 by having
  // a sibling created by direct action before the outer add is accepted.
  // The outer add then can't be accepted (its name would clash). On
  // Alice's next /queue, it transitions to case-3 invalid; the nested
  // rename was latent (decision dep on outer add), so it becomes case-1
  // invalid via propagation.
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
          children: [{ op: "rename", id: c1, name: "RenamedSpec" }],
        },
      ],
    },
  });
  const outerAddId = sub.payload.children![0].changeId!;
  const nestedRenameId = sub.payload.children![0].children![0].changeId!;

  // Bob directly creates "Wrapper" under r1 (no, wait — Bob doesn't own
  // r1). Alice creates it.
  const directWrapper = (await createTaxon(app, "alice", "Wrapper")).id;
  await attach(app, "alice", r1, directWrapper);

  // Now Alice's queued add (Wrapper) would clash. Read her /queue → lazy
  // detection kicks in; outer add becomes case-3 invalid; nested rename
  // becomes case-1 invalid.
  await queueOf(app, "alice");
  const status = walkStatusNodes(await statusFor(app, sub.id));
  const outer = status.find((n) => n.changeId === outerAddId);
  const nested = status.find((n) => n.changeId === nestedRenameId);
  assert.equal(outer?.disposition, "invalid");
  assert.equal(nested?.disposition, "invalid");
  assert.match(nested?.reason ?? "", /became invalid/);
});

test("§11.4 case 1: invalidation cascades through nested add chain (A1 → A2 → A3)", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;

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
          name: "A1",
          children: [
            {
              op: "add",
              id: null,
              name: "A2",
              children: [{ op: "add", id: null, name: "A3" }],
            },
          ],
        },
      ],
    },
  });
  const a1Id = sub.payload.children![0].changeId!;
  const a2Id = sub.payload.children![0].children![0].changeId!;
  const a3Id =
    sub.payload.children![0].children![0].children![0].changeId!;

  // Alice rejects A1.
  await rejectOk(app, "alice", a1Id);

  // All three are now invalid; A2 and A3 via case-1 propagation.
  const status = walkStatusNodes(await statusFor(app, sub.id));
  assert.equal(status.find((n) => n.changeId === a1Id)?.disposition, "rejected");
  assert.equal(status.find((n) => n.changeId === a2Id)?.disposition, "invalid");
  assert.equal(status.find((n) => n.changeId === a3Id)?.disposition, "invalid");
});

// --- Case 2: self-invalidation -------------------------------------------

test("§11.4 case 2: successful accept auto-dismisses a sibling that now clashes", async () => {
  // Alice has two queued renames in the same tree: rename t1 -> "Foo"
  // and rename t2 -> "Foo". Accepting the first makes the second a clash.
  // The second auto-dismisses (case 2).
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Root")).id;
  const t1 = (await createTaxon(app, "alice", "One")).id;
  const t2 = (await createTaxon(app, "alice", "Two")).id;
  await attach(app, "alice", r1, t1);
  await attach(app, "alice", r1, t2);

  // Two separate proposals — each carries one rename to make them
  // independently queued.
  const sub1 = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: t1, name: "Foo" }],
    },
  });
  const ren1Id = sub1.payload.children![0].changeId!;
  const sub2 = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: t2, name: "Foo" }],
    },
  });
  const ren2Id = sub2.payload.children![0].changeId!;

  await acceptOk(app, "alice", ren1Id);

  // ren2 is auto-dismissed.
  const aliceQ = await queueOf(app, "alice");
  assert.ok(!aliceQ.some((e) => e.changeId === ren2Id));
  const status = walkStatusNodes(await statusFor(app, sub2.id));
  const ren2 = status.find((n) => n.changeId === ren2Id);
  assert.equal(ren2?.disposition, "invalid");
  assert.match(ren2?.reason ?? "", /self-invalidated by your accept/);
});

test("§11.4 case 2: failed accept auto-dismisses the change itself (replaces Phase-6 placeholder)", async () => {
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
  const renameId = sub.payload.children![0].changeId!;

  const res = await app.request(`/changes/${renameId}/accept`, {
    method: "POST",
    headers: { "X-Username": "alice" },
  });
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.details?.kind, "name_clash");

  // Change auto-dismissed.
  const aliceQ = await queueOf(app, "alice");
  assert.ok(!aliceQ.some((e) => e.changeId === renameId));
  const status = walkStatusNodes(await statusFor(app, sub.id));
  const node = status.find((n) => n.changeId === renameId);
  assert.equal(node?.disposition, "invalid");
  assert.match(node?.reason ?? "", /self-invalidated by your accept/);
});

test("§11.4 case 2 via cascade: cascade succeeds; a sibling queued change broken by it auto-dismisses", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;

  // Alice has a queued rename of r1 -> "Foo" (sub1).
  const sub1 = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "rename", id: r1, name: "Foo" },
  });
  const renR1Id = sub1.payload.changeId!;

  // Separately, Alice cascade-accepts a subtree under r1 that creates
  // a sibling "Foo" — once accepted, sub1's rename would clash with
  // the new sibling, so sub1 auto-dismisses (case 2 via cascade).
  const sub2 = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", id: null, name: "Foo" }],
    },
  });
  const addFooId = sub2.payload.children![0].changeId!;

  await acceptCascadeOk(app, "alice", addFooId);

  // sub1 is auto-dismissed.
  const aliceQ = await queueOf(app, "alice");
  assert.ok(!aliceQ.some((e) => e.changeId === renR1Id));
  const status = walkStatusNodes(await statusFor(app, sub1.id));
  const node = status.find((n) => n.changeId === renR1Id);
  assert.equal(node?.disposition, "invalid");
  assert.match(node?.reason ?? "", /accept-cascade rooted at/);
});

// --- Case 3: external invalidation ---------------------------------------

test("§11.4 case 3: direct rename by another user makes a queued rename clash; marked invalid, kept queued", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Fantasy")).id;
  const c2 = (await createTaxon(app, "alice", "Mystery")).id;
  await attach(app, "alice", r1, c1);
  await attach(app, "alice", r1, c2);

  // Bob proposes rename of c2 → "SciFi". Queued for Alice.
  const sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c2, name: "SciFi" }],
    },
  });
  const renameId = sub.payload.children![0].changeId!;

  // Alice directly renames c1 → "SciFi". (Direct §6.2 action; she
  // doesn't know about Bob's queued rename.)
  await renameTaxon(app, "alice", c1, "SciFi");

  // Alice reads her queue → lazy detection marks Bob's rename as case-3
  // invalid, kept in queue.
  const aliceQ = await queueOf(app, "alice");
  const entry = aliceQ.find((e) => e.changeId === renameId);
  assert.ok(entry, "change should still be in queue (case 3)");
  assert.equal(entry?.state, "invalid");
  const status = walkStatusNodes(await statusFor(app, sub.id));
  const node = status.find((n) => n.changeId === renameId);
  assert.equal(node?.disposition, "invalid");
  assert.match(node?.reason ?? "", /externally invalidated/);
});

test("§11.4 case 3: direct detach by another user (Appendix A.2 tail) invalidates a queued create under the grafted taxon", async () => {
  // Appendix A.2 narrative: Frank accepts a graft of a3 under b2 (a3
  // becomes shared); Grace proposed a nested create under a3 (routed
  // to Erin); Frank then directly detaches a3 from b2; on Erin's next
  // queue read, the nested create is case-3 invalid.
  const app = await freshApp();
  await register(app, "dana");
  await register(app, "erin");
  await register(app, "frank");
  await register(app, "grace");
  const b1 = (await createTaxon(app, "frank", "Genre Index")).id;
  const b2 = (await createTaxon(app, "frank", "Dark Fiction")).id;
  await attach(app, "frank", b1, b2);
  const a3 = (await createTaxon(app, "erin", "Psychological Thriller")).id;

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
              ],
            },
          ],
        },
      ],
    },
  });
  const graftId = sub.payload.children![0].children![0].changeId!;
  const innerId =
    sub.payload.children![0].children![0].children![0].changeId!;

  await acceptOk(app, "frank", graftId);
  // Inner create is now queued for Erin.
  const erinQBefore = await queueOf(app, "erin");
  assert.ok(erinQBefore.some((e) => e.changeId === innerId && e.state === "queued"));

  // Frank directly detaches a3 from b2 — a3 is no longer in tree b1.
  await detachEdge(app, "frank", b2, a3);

  // Erin reads her queue → inner create is case-3 invalid (its
  // existence dep — the grafted a3 under b2 — is gone).
  const erinQAfter = await queueOf(app, "erin");
  const entry = erinQAfter.find((e) => e.changeId === innerId);
  assert.ok(entry, "inner create should still be in Erin's queue (case 3)");
  assert.equal(entry?.state, "invalid");
});

test("§11.4 case 3: a different reviewer's accept (on a different proposal) invalidates Y's queued change", async () => {
  // Two independent proposals targeting the same tree. Reviewer X accepts
  // a change that, as a side-effect, breaks Y's queued change.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Spec")).id;
  const c2 = (await createTaxon(app, "bob", "Existing")).id;
  await attach(app, "alice", r1, c1);
  await attach(app, "alice", r1, c2);

  // Sub1: Carol proposes rename of c2 → "New" (Bob is reviewer, owner of c2).
  const sub1 = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c2, name: "New" }],
    },
  });
  const bobRenameId = sub1.payload.children![0].changeId!;

  // Sub2: Carol proposes rename of c1 → "New" (Alice is reviewer).
  const sub2 = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c1, name: "New" }],
    },
  });
  const aliceRenameId = sub2.payload.children![0].changeId!;

  // Alice accepts her rename first — c1 is now "New".
  await acceptOk(app, "alice", aliceRenameId);

  // Bob now reads his queue → his rename of c2 → "New" would clash.
  // case-3 invalidation (caused by Alice's action).
  const bobQ = await queueOf(app, "bob");
  const entry = bobQ.find((e) => e.changeId === bobRenameId);
  assert.ok(entry);
  assert.equal(entry?.state, "invalid");
});
