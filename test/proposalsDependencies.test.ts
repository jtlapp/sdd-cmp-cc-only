// PRD §10.2, §11.3 — dependency classification observable via dispositions.
//
// Decision dependency = add/graft ancestor on the payload path. A change
// with any decision-dep ancestor is LATENT at submission. Existence
// dependencies (no-op / rename ancestors) do NOT gate queuing — the §11.3
// keystone is that a pending rename does not block a descendant.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  attach,
  createTaxon,
  findStatusByChangeId,
  freshApp,
  ProposalResponse,
  register,
  submitOk,
  walkStatusNodes,
} from "./proposalsTestHelpers.js";

// --- Decision-dep ancestor → latent ----------------------------------------

test("nested add under add-create → latent (decision dep)", async () => {
  // r1 (Alice). Proposal: under r1 add-create "Outer", then under it
  // add-create "Inner". Outer is queued (no ancestor add); Inner is
  // latent (add-create ancestor).
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const resp: ProposalResponse = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        {
          op: "add",
          id: null,
          name: "Outer",
          children: [{ op: "add", id: null, name: "Inner" }],
        },
      ],
    },
  });
  const ops = walkStatusNodes(resp.payload).filter((n) => n.op !== "no-op");
  assert.equal(ops.length, 2);
  const outer = ops.find((n) => n.name === "Outer")!;
  const inner = ops.find((n) => n.name === "Inner")!;
  assert.equal(outer.disposition, "queued");
  assert.equal(inner.disposition, "latent");
});

test("nested add under add-graft → latent", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const orphan = (await createTaxon(app, "bob", "Mystery")).id;
  const resp = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        {
          op: "add",
          id: orphan,
          children: [{ op: "add", id: null, name: "Cozy Mystery" }],
        },
      ],
    },
  });
  const ops = walkStatusNodes(resp.payload).filter((n) => n.op !== "no-op");
  const graft = ops.find((n) => n.id === orphan)!;
  const inner = ops.find((n) => n.name === "Cozy Mystery")!;
  assert.equal(graft.disposition, "queued");
  assert.equal(inner.disposition, "latent");
});

test("nested rename under add-create → latent (path-based, not target-based)", async () => {
  // The rename targets an EXISTING taxon (so by itself it'd be queued),
  // but it sits under an add-create on the payload path, so it's latent.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "bob", "Fantasy")).id;
  await attach(app, "alice", r1, c1);
  const resp = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        {
          op: "add",
          id: null,
          name: "Outer",
          children: [{ op: "rename", id: c1, name: "Epic Fantasy" }],
        },
      ],
    },
  });
  const ops = walkStatusNodes(resp.payload).filter((n) => n.op !== "no-op");
  const rename = ops.find((n) => n.op === "rename")!;
  assert.equal(rename.disposition, "latent");
});

test("nested detach under add-graft → latent", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const orphan = (await createTaxon(app, "bob", "Mystery")).id;
  const orphanChild = (await createTaxon(app, "bob", "Cozy")).id;
  await attach(app, "bob", orphan, orphanChild);
  const resp = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        {
          op: "add",
          id: orphan,
          children: [{ op: "detach", id: orphanChild }],
        },
      ],
    },
  });
  const ops = walkStatusNodes(resp.payload).filter((n) => n.op !== "no-op");
  const detach = ops.find((n) => n.op === "detach")!;
  assert.equal(detach.disposition, "latent");
});

// --- Existence-dep ancestor → queued ---------------------------------------

test("nested add under top rename → queued (rename is existence dep only)", async () => {
  // r1 (Alice). Top: rename r1. Nested: add-create.
  // Top rename is queued (no add ancestor). Nested add is queued
  // (no add ancestor on its path either — only a rename ancestor, which
  // is an existence dep).
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const resp = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "rename",
      id: r1,
      name: "Renamed Fiction",
      children: [{ op: "add", id: null, name: "Speculative Fiction" }],
    },
  });
  const ops = walkStatusNodes(resp.payload).filter((n) => n.op !== "no-op");
  for (const op of ops) {
    assert.equal(op.disposition, "queued", `${op.op}/${op.name} expected queued`);
  }
});

test("stacked renames → all queued (no add ancestors anywhere)", async () => {
  // r1 (Alice), c1 (Alice), c1a (Alice). Three renames stacked.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "A")).id;
  const c1 = (await createTaxon(app, "alice", "B")).id;
  const c1a = (await createTaxon(app, "alice", "C")).id;
  await attach(app, "alice", r1, c1);
  await attach(app, "alice", c1, c1a);
  const resp = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "rename",
      id: r1,
      name: "Aa",
      children: [
        {
          op: "rename",
          id: c1,
          name: "Bb",
          children: [{ op: "rename", id: c1a, name: "Cc" }],
        },
      ],
    },
  });
  const ops = walkStatusNodes(resp.payload).filter((n) => n.op !== "no-op");
  assert.equal(ops.length, 3);
  for (const op of ops) {
    assert.equal(op.disposition, "queued");
  }
});

test("nested detach under no-op anchor → queued", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "A")).id;
  const c1 = (await createTaxon(app, "alice", "B")).id;
  await attach(app, "alice", r1, c1);
  const resp = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "detach", id: c1 }],
    },
  });
  const ops = walkStatusNodes(resp.payload).filter((n) => n.op !== "no-op");
  assert.equal(ops.length, 1);
  assert.equal(ops[0].disposition, "queued");
});

// --- Appendix A.1 — the full mixed-path example ----------------------------

test("Appendix A.1 dispositions match the worked example", async () => {
  // Build the exact A.1 live state.
  //   r1 Fiction (Alice)
  //   └── c1 Speculative Fiction (Alice)
  //       └── c2 Fantasy (Bob)
  //           └── c3 Epic Fantasy (Bob)
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

  const resp = await submitOk(app, "carol", {
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

  // Per A.1's table:
  //   rename c1            → queued
  //   rename c3            → queued
  //   add Urban Fantasy    → queued (no add ancestor — rename(c1) is exist dep)
  //   add Paranormal       → latent (add ancestor: Urban Fantasy create)
  const all = walkStatusNodes(resp.payload).filter((n) => n.op !== "no-op");
  assert.equal(all.length, 4);
  const renameC1 = all.find((n) => n.op === "rename" && n.id === c1)!;
  const renameC3 = all.find((n) => n.op === "rename" && n.id === c3)!;
  const urbanFantasy = all.find((n) => n.name === "Urban Fantasy")!;
  const paranormal = all.find((n) => n.name === "Paranormal Romance")!;
  assert.equal(renameC1.disposition, "queued");
  assert.equal(renameC3.disposition, "queued");
  assert.equal(urbanFantasy.disposition, "queued");
  assert.equal(paranormal.disposition, "latent");
  // Round-trip via findStatusByChangeId for completeness.
  for (const n of [renameC1, renameC3, urbanFantasy, paranormal]) {
    assert.equal(findStatusByChangeId(resp.payload, n.changeId!)?.changeId, n.changeId);
  }
});

// --- Top taxon as existence dependency -------------------------------------

test("top no-op is structural; every operative path includes it (observable via tree shape)", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Fantasy")).id;
  await attach(app, "alice", r1, c1);
  const resp = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c1, name: "Epic Fantasy" }],
    },
  });
  assert.equal(resp.payload.op, "no-op");
  assert.equal(resp.payload.disposition, "structural");
  assert.equal(resp.payload.changeId, undefined);
  assert.equal(resp.payload.children?.length, 1);
  assert.equal(resp.payload.children?.[0].disposition, "queued");
});
