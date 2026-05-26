// Phase 7 — accept-cascade rollback (§12.2 / errata E1).
//
// Each test verifies:
//   (a) response is 409 conflict with details.kind = "cascade_rollback",
//       details.failedChangeId naming the offender, and details.cause
//       carrying the invariant violation;
//   (b) every change in the cascade has its state, reviewer, and queue
//       position restored byte-equal;
//   (c) live state (taxa, edges, owners) is byte-equal to its pre-call
//       value.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  acceptCascade,
  acceptOk,
  attach,
  createTaxon,
  ErrorBody,
  freshApp,
  register,
  submitOk,
  type App,
} from "./proposalsTestHelpers.js";

async function snapshotTrees(app: App): Promise<unknown> {
  const r = await app.request("/trees");
  const list = (await r.json()) as { trees: { id: string }[] };
  const trees: Record<string, unknown> = {};
  for (const root of list.trees) {
    const res = await app.request(`/trees/${root.id}`);
    trees[root.id] = await res.json();
  }
  return trees;
}

async function snapshotTaxa(app: App): Promise<unknown> {
  const r = await app.request("/taxa");
  return r.json();
}

async function snapshotProposal(app: App, id: string): Promise<unknown> {
  const r = await app.request(`/proposals/${id}`);
  return r.json();
}

// 1. Mid-cascade in-tree name clash.
test("cascade rolls back on mid-cascade in-tree name clash; live state and bookkeeping restored", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  // Pre-existing sibling under r1 with name that will clash.
  const fantasy = (await createTaxon(app, "alice", "Fantasy")).id;
  await attach(app, "alice", r1, fantasy);

  // Bob proposes: under r1, add-create "Wrapper"; under Wrapper, add-create
  // "Fantasy" — sibling of fantasy in r1 would not clash (different parent),
  // but the in-tree-uniqueness invariant applies to the whole tree. So
  // this creates a name_clash at the tree level.
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
          children: [{ op: "add", id: null, name: "Fantasy" }],
        },
      ],
    },
  });
  const wrapperId = sub.payload.children![0].changeId!;

  const treesBefore = await snapshotTrees(app);
  const taxaBefore = await snapshotTaxa(app);
  const propBefore = await snapshotProposal(app, sub.id);

  const res = await acceptCascade(app, "alice", wrapperId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "conflict");
  assert.equal(body.error.details?.kind, "cascade_rollback");
  assert.equal(body.error.details?.rootChangeId, wrapperId);
  // The failing change is the second add (the Fantasy one).
  const cause = body.error.details?.cause as { kind?: string };
  assert.equal(cause.kind, "name_clash");

  // Live state byte-equal.
  assert.deepEqual(await snapshotTrees(app), treesBefore);
  assert.deepEqual(await snapshotTaxa(app), taxaBefore);
  // Proposal/change state byte-equal — both changes restored to queued/latent.
  assert.deepEqual(await snapshotProposal(app, sub.id), propBefore);
});

// 2. Mid-cascade cross-tree name clash (§14 bullet 5).
test("cascade rolls back on cross-tree name clash; restores both trees", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  // Alice owns two roots; c1 is shared between them.
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Fantasy")).id;
  const r2 = (await createTaxon(app, "alice", "Genre Index")).id;
  const conflicting = (await createTaxon(app, "alice", "Suspense")).id;
  await attach(app, "alice", r1, c1);
  await attach(app, "alice", r2, c1);
  await attach(app, "alice", r2, conflicting);

  // Bob proposes: under r1, no-op anchor at c1; under c1, rename c1 → "Suspense".
  // The rename clashes in r2 (which contains both c1 and "Suspense"), even
  // though it's clean within r1.
  // Make it a cascade by nesting under an add-create.
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
          children: [{ op: "rename", id: c1, name: "Suspense" }],
        },
      ],
    },
  });
  const wrapperId = sub.payload.children![0].changeId!;

  const treesBefore = await snapshotTrees(app);
  const propBefore = await snapshotProposal(app, sub.id);

  const res = await acceptCascade(app, "alice", wrapperId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.details?.kind, "cascade_rollback");
  const cause = body.error.details?.cause as { kind?: string; rootId?: string };
  assert.equal(cause.kind, "name_clash");
  // The clash is in r2, not the target r1.
  assert.equal(cause.rootId, r2);

  assert.deepEqual(await snapshotTrees(app), treesBefore);
  assert.deepEqual(await snapshotProposal(app, sub.id), propBefore);
});

// 3. Mid-cascade cycle.
test("cascade rolls back on mid-cascade cycle (graft of an ancestor)", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Root")).id;
  const c1 = (await createTaxon(app, "alice", "Child")).id;
  await attach(app, "alice", r1, c1);

  // Cascade: add-create "Wrapper" under c1; then graft r1 (the ancestor)
  // under "Wrapper" — would create a cycle r1 -> c1 -> Wrapper -> r1.
  const sub = await submitOk(app, "bob", {
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
              children: [{ op: "add", id: r1 }],
            },
          ],
        },
      ],
    },
  });
  const wrapperId = sub.payload.children![0].children![0].changeId!;

  const treesBefore = await snapshotTrees(app);
  const propBefore = await snapshotProposal(app, sub.id);

  const res = await acceptCascade(app, "alice", wrapperId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.details?.kind, "cascade_rollback");
  const cause = body.error.details?.cause as { kind?: string };
  assert.equal(cause.kind, "cycle");

  assert.deepEqual(await snapshotTrees(app), treesBefore);
  assert.deepEqual(await snapshotProposal(app, sub.id), propBefore);
});

// 4. Mid-cascade in-tree duplicate (diamond).
test("cascade rolls back on mid-cascade in-tree duplicate (diamond)", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Root")).id;
  const c1 = (await createTaxon(app, "alice", "Branch")).id;
  const c2 = (await createTaxon(app, "alice", "Leaf")).id;
  await attach(app, "alice", r1, c1);
  await attach(app, "alice", c1, c2);

  // Cascade: under r1, add-create "Wrapper"; under "Wrapper", graft c2 —
  // would create a diamond (c2 reachable r1->c1->c2 and r1->Wrapper->c2).
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
          children: [{ op: "add", id: c2 }],
        },
      ],
    },
  });
  const wrapperId = sub.payload.children![0].changeId!;

  const treesBefore = await snapshotTrees(app);
  const propBefore = await snapshotProposal(app, sub.id);

  const res = await acceptCascade(app, "alice", wrapperId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.details?.kind, "cascade_rollback");
  const cause = body.error.details?.cause as { kind?: string };
  assert.equal(cause.kind, "in_tree_duplicate");

  assert.deepEqual(await snapshotTrees(app), treesBefore);
  assert.deepEqual(await snapshotProposal(app, sub.id), propBefore);
});

// 5. First-step failure.
test("cascade rolls back on first-step failure with nothing applied", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const fantasy = (await createTaxon(app, "alice", "Fantasy")).id;
  await attach(app, "alice", r1, fantasy);

  // Seed change itself would clash.
  const sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", id: null, name: "Fantasy" }],
    },
  });
  const seedId = sub.payload.children![0].changeId!;

  const treesBefore = await snapshotTrees(app);
  const propBefore = await snapshotProposal(app, sub.id);

  const res = await acceptCascade(app, "alice", seedId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.details?.kind, "cascade_rollback");
  assert.equal(body.error.details?.failedChangeId, seedId);

  assert.deepEqual(await snapshotTrees(app), treesBefore);
  assert.deepEqual(await snapshotProposal(app, sub.id), propBefore);
});

// 6. §12.2 standalone-vs-cascade non-equivalence.
test("§12.2 non-equivalence: same change validates standalone but cascade rolls back when an earlier step would set up the clash", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;

  // Bob proposes two siblings: add-create "Foo" and add-create "Foo"
  // (case-sensitive same name — clashes within tree). Each is its own
  // change; they're not stacked in a cascade (peers), so cascade
  // wouldn't pick up the second from the first. To exercise non-
  // equivalence we need a chain: outer add-create "Wrapper" with two
  // nested add-creates "Foo" and "Foo".
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
          children: [
            { op: "add", id: null, name: "Foo" },
            { op: "add", id: null, name: "Foo" },
          ],
        },
      ],
    },
  });
  const wrapperId = sub.payload.children![0].changeId!;
  const foo1Id = sub.payload.children![0].children![0].changeId!;
  const foo2Id = sub.payload.children![0].children![1].changeId!;

  // Standalone foo1 (after wrapper accepted) would succeed; foo2 (after
  // wrapper AND foo1 accepted) clashes. The cascade discovers this and
  // rolls back the whole thing including wrapper and foo1.
  const treesBefore = await snapshotTrees(app);
  const propBefore = await snapshotProposal(app, sub.id);

  const res = await acceptCascade(app, "alice", wrapperId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.details?.kind, "cascade_rollback");
  // The failing change is the second Foo.
  assert.equal(body.error.details?.failedChangeId, foo2Id);

  assert.deepEqual(await snapshotTrees(app), treesBefore);
  assert.deepEqual(await snapshotProposal(app, sub.id), propBefore);

  // Pin standalone semantics: accept just the wrapper, then just foo1 —
  // both succeed. Then attempting foo2 standalone fails (case 2 auto-
  // dismiss) but wrapper and foo1 remain accepted.
  await acceptOk(app, "alice", wrapperId);
  await acceptOk(app, "alice", foo1Id);
  const failFoo2 = await app.request(`/changes/${foo2Id}/accept`, {
    method: "POST",
    headers: { "X-Username": "alice" },
  });
  assert.equal(failFoo2.status, 409);
  // Wrapper and foo1 are still accepted in live state.
  const r1After = await app.request(`/trees/${r1}`);
  const r1Tree = (await r1After.json()) as {
    children: Array<{ id: string; children?: unknown[] }>;
  };
  assert.equal(r1Tree.children.length, 1);
});
