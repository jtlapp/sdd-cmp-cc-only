// Phase-6 §10.3 acceptance-time validation for add (create + graft):
// cycle, in-tree duplicate, name clash (within the target tree and
// within the grafted subtree's contribution to the target tree).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  acceptChange,
  acceptOk,
  attach,
  createTaxon,
  ErrorBody,
  freshApp,
  register,
  submitOk,
  type App,
} from "./proposalsTestHelpers.js";

async function getTaxonRecord(app: App, id: string) {
  const res = await app.request(`/taxa/${id}`);
  assert.equal(res.status, 200);
  return (await res.json()) as { id: string; name: string; childIds: string[]; parentIds: string[] };
}

// --- Graft validations -----------------------------------------------------

test("graft that would create a cycle → 409", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const a1 = (await createTaxon(app, "alice", "Fiction")).id;
  const a2 = (await createTaxon(app, "alice", "Fantasy")).id;
  const a3 = (await createTaxon(app, "alice", "Epic Fantasy")).id;
  await attach(app, "alice", a1, a2);
  await attach(app, "alice", a2, a3);
  // Proposal: graft a1 under a3 — would close a cycle a1→a2→a3→a1.
  const sub = await submitOk(app, "bob", {
    targetRootId: a1,
    topTaxonId: a1,
    payload: {
      op: "no-op",
      id: a1,
      children: [
        {
          op: "no-op",
          id: a2,
          children: [
            {
              op: "no-op",
              id: a3,
              children: [{ op: "add", id: a1 }],
            },
          ],
        },
      ],
    },
  });
  const changeId = sub.payload.children![0].children![0].children![0].changeId!;

  // Routes to owner of a3 = Alice.
  const res = await acceptChange(app, "alice", changeId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "conflict");
  assert.equal(body.error.details?.kind, "cycle");

  // State unchanged: a3 still has no children.
  const a3After = await getTaxonRecord(app, a3);
  assert.equal(a3After.childIds.length, 0);
});

test("graft that would create an in-tree duplicate (diamond) → 409", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Fantasy")).id;
  const c2 = (await createTaxon(app, "alice", "Mystery")).id;
  await attach(app, "alice", r1, c1);
  await attach(app, "alice", r1, c2);
  // Submit a graft of c1 under c2 — would make r1 reach c1 via two paths.
  const sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        {
          op: "no-op",
          id: c2,
          children: [{ op: "add", id: c1 }],
        },
      ],
    },
  });
  const changeId = sub.payload.children![0].children![0].changeId!;

  const res = await acceptChange(app, "alice", changeId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "conflict");
  assert.equal(body.error.details?.kind, "in_tree_duplicate");
  assert.equal(body.error.details?.rootId, r1);

  // c2 still has no children.
  assert.equal((await getTaxonRecord(app, c2)).childIds.length, 0);
});

test("graft brings a subtree whose names clash with the target tree → 409", async () => {
  // T1 root r1 has child "Mystery". T2 root b1 has child s1 ("Suspense")
  // whose grandchild m2 is also "Mystery". Graft s1 under r1.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const m1 = (await createTaxon(app, "alice", "Mystery")).id;
  await attach(app, "alice", r1, m1);
  const b1 = (await createTaxon(app, "alice", "Genre Index")).id;
  const s1 = (await createTaxon(app, "alice", "Suspense")).id;
  const m2 = (await createTaxon(app, "alice", "Mystery")).id;
  await attach(app, "alice", b1, s1);
  await attach(app, "alice", s1, m2);

  const sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", id: s1 }],
    },
  });
  const changeId = sub.payload.children![0].changeId!;

  const res = await acceptChange(app, "alice", changeId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "conflict");
  assert.equal(body.error.details?.kind, "name_clash");
  assert.equal(body.error.details?.rootId, r1);
  // The two taxa carrying the clashing name include m1 and m2.
  const clashTaxa = body.error.details?.taxa as string[];
  assert.ok(clashTaxa.includes(m1));
  assert.ok(clashTaxa.includes(m2));

  // r1 still has only m1 as child.
  assert.deepEqual((await getTaxonRecord(app, r1)).childIds, [m1]);
});

test("happy cross-tree graft → 200; grafted taxon becomes shared", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const b1 = (await createTaxon(app, "alice", "Genre Index")).id;
  const s1 = (await createTaxon(app, "alice", "Suspense")).id;
  await attach(app, "alice", b1, s1);

  const sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", id: s1 }],
    },
  });
  const changeId = sub.payload.children![0].changeId!;

  await acceptOk(app, "alice", changeId);
  // s1 now has two parents: b1 and r1. Shared.
  const s1After = await getTaxonRecord(app, s1);
  assert.deepEqual(s1After.parentIds.sort(), [b1, r1].sort());
});

// --- Create validations ----------------------------------------------------

test("create whose name clashes with an existing sibling → 409", async () => {
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
      children: [{ op: "add", id: null, name: "Fantasy" }],
    },
  });
  const changeId = sub.payload.children![0].changeId!;

  const res = await acceptChange(app, "alice", changeId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "conflict");
  assert.equal(body.error.details?.kind, "name_clash");

  // r1 still has only c1.
  assert.deepEqual((await getTaxonRecord(app, r1)).childIds, [c1]);
});

test("create whose name clashes case-insensitively → 409 (§3.4)", async () => {
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
      children: [{ op: "add", id: null, name: "FANTASY" }],
    },
  });
  const changeId = sub.payload.children![0].changeId!;

  const res = await acceptChange(app, "alice", changeId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.details?.kind, "name_clash");
});

test("happy create at root level → 200, new taxon attached", async () => {
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
  const r1After = await getTaxonRecord(app, r1);
  assert.equal(r1After.childIds.length, 1);
  const newRec = await getTaxonRecord(app, r1After.childIds[0]);
  assert.equal(newRec.name, "Fantasy");
  assert.equal(newRec.parentIds[0], r1);
});
