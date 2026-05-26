// §10.3 acceptance-time validation for renames — verifies the
// invariant module is invoked over the FULL containing tree(s), not
// just the target tree. (Updated in Phase 7: the failed-accept path
// now transitions the change to `invalid` per §11.4 case 2, replacing
// Phase 6's "stays queued" placeholder. Live state is still byte-equal
// to its pre-call value on a failed accept — only the change record
// transitions.)

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
  return (await res.json()) as { id: string; name: string; childIds: string[] };
}

async function getStatusDisp(app: App, proposalId: string, changeId: string) {
  const res = await app.request(`/proposals/${proposalId}`);
  const body = (await res.json()) as {
    payload: { changeId?: string; disposition: string; children?: unknown[] };
  };
  // Walk for the change.
  function walk(n: { changeId?: string; disposition: string; children?: unknown[] }): string | undefined {
    if (n.changeId === changeId) return n.disposition;
    for (const child of (n.children as { changeId?: string; disposition: string; children?: unknown[] }[]) ?? []) {
      const r = walk(child);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  return walk(body.payload);
}

test("rename to a name that clashes in the target tree → 409 conflict, change auto-dismissed (§11.4 case 2)", async () => {
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

  // Pre snapshot.
  const beforeMystery = (await getTaxonRecord(app, mystery)).name;

  const res = await acceptChange(app, "alice", changeId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "conflict");
  // Message and details mention the clash.
  assert.match(body.error.message, /name_clash|name "fantasy"|fantasy/i);
  assert.equal(body.error.details?.kind, "name_clash");
  assert.equal(body.error.details?.rootId, r1);

  // Mystery's name is unchanged — live state byte-equal to pre-call.
  assert.equal((await getTaxonRecord(app, mystery)).name, beforeMystery);
  // §11.4 case 2: change is auto-dismissed (state=invalid, dequeued).
  assert.equal(await getStatusDisp(app, sub.id, changeId), "invalid");
});

test("rename clashes in ANOTHER containing tree (not the target) → 409 conflict", async () => {
  // Alice owns two roots; c1 is shared between them. Rename c1 to a name
  // that clashes only in the OTHER tree.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Fantasy")).id;
  const r2 = (await createTaxon(app, "alice", "Genre Index")).id;
  const c2 = (await createTaxon(app, "alice", "Suspense")).id;
  await attach(app, "alice", r1, c1);
  await attach(app, "alice", r2, c2);
  await attach(app, "alice", r2, c1); // c1 now shared between r1 and r2.

  const sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c1, name: "Suspense" }],
    },
  });
  const changeId = sub.payload.children![0].changeId!;

  const res = await acceptChange(app, "alice", changeId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "conflict");
  // The conflicting root is r2, not r1.
  assert.equal(body.error.details?.rootId, r2);
});

test("rename across two trees both clean → accepted; both trees see new name", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Fantasy")).id;
  const r2 = (await createTaxon(app, "alice", "Genre Index")).id;
  await attach(app, "alice", r1, c1);
  await attach(app, "alice", r2, c1);

  const sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c1, name: "Speculative Fiction" }],
    },
  });
  const changeId = sub.payload.children![0].changeId!;

  await acceptOk(app, "alice", changeId);

  // Both trees see c1 with the new name.
  const tree1 = (await (await app.request(`/trees/${r1}`)).json()) as {
    children: { id: string; name?: string }[];
  };
  const tree2 = (await (await app.request(`/trees/${r2}`)).json()) as {
    children: { id: string; name?: string }[];
  };
  assert.equal(tree1.children.find((c) => c.id === c1)?.name, "Speculative Fiction");
  assert.equal(tree2.children.find((c) => c.id === c1)?.name, "Speculative Fiction");
});

test("rename to the same name (case-insensitive no-op) → accepted", async () => {
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
      children: [{ op: "rename", id: c1, name: "FANTASY" }],
    },
  });
  const changeId = sub.payload.children![0].changeId!;

  await acceptOk(app, "alice", changeId);
  // c1's stored name is the new (case-variant) value.
  assert.equal((await getTaxonRecord(app, c1)).name, "FANTASY");
});
