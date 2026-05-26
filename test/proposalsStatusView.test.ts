// PRD §11.5, §15.2 — GET /proposals/{id} status view.
//
// The view is "isomorphic to the submitted payload tree" with a
// disposition per node. Tests pin structure and shape, not prose.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  attach,
  createTaxon,
  ErrorBody,
  freshApp,
  getProposal,
  ProposalResponse,
  register,
  StatusNode,
  submitOk,
  walkStatusNodes,
} from "./proposalsTestHelpers.js";

function shapeNoChangeIds(node: StatusNode): unknown {
  // For round-trip equality assertions we strip server-assigned changeIds,
  // since two equivalent submissions get different changeIds.
  const { changeId: _c, ...rest } = node;
  if (rest.children !== undefined) {
    rest.children = rest.children.map(shapeNoChangeIds) as StatusNode[];
  }
  void _c;
  return rest;
}

// --- Isomorphism -----------------------------------------------------------

test("status view shape matches submitted payload (A.1)", async () => {
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

  // Walk depth-first; expect 7 nodes (r1, c1, c2, c3, UF, PR, ...wait re-count).
  // r1(no-op) → c1(rename) → c2(no-op) → c3(rename), Urban Fantasy(add) → Paranormal Romance(add)
  // = 6 nodes total.
  const all = walkStatusNodes(resp.payload);
  assert.equal(all.length, 6);
  // Parent/child relationships match.
  assert.equal(resp.payload.id, r1);
  assert.equal(resp.payload.children?.length, 1);
  const c1Node = resp.payload.children![0];
  assert.equal(c1Node.id, c1);
  assert.equal(c1Node.children?.length, 1);
  const c2Node = c1Node.children![0];
  assert.equal(c2Node.id, c2);
  assert.equal(c2Node.children?.length, 2);
});

test("every operative node carries a changeId; every no-op has none", async () => {
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
      children: [
        { op: "rename", id: c1, name: "Epic Fantasy" },
        { op: "add", id: null, name: "Urban Fantasy" },
      ],
    },
  });
  for (const n of walkStatusNodes(resp.payload)) {
    if (n.op === "no-op") {
      assert.equal(n.changeId, undefined);
      assert.equal(n.disposition, "structural");
    } else {
      assert.ok(typeof n.changeId === "string" && n.changeId.length > 0);
      assert.ok(["latent", "queued"].includes(n.disposition));
    }
  }
});

test("status nodes echo op/id/name fields submitted (unknown keys dropped)", async () => {
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
      bonus: 1,
      children: [{ op: "rename", id: c1, name: "Epic Fantasy", extra: "x" }],
    },
  });
  const renameNode = resp.payload.children![0];
  assert.equal(renameNode.op, "rename");
  assert.equal(renameNode.id, c1);
  assert.equal(renameNode.name, "Epic Fantasy");
  assert.equal((renameNode as unknown as Record<string, unknown>).extra, undefined);
});

// --- Disposition rendering --------------------------------------------------

test("disposition is one of the five real states, or 'structural' for no-op", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
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
          children: [{ op: "add", id: null, name: "Inner" }],
        },
      ],
    },
  });
  for (const n of walkStatusNodes(resp.payload)) {
    assert.ok(
      ["latent", "queued", "accepted", "rejected", "invalid", "structural"]
        .includes(n.disposition),
    );
  }
});

test("reason field is absent in Phase 5 (no rejection/invalidation paths exercised)", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const resp = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", id: null, name: "Speculative Fiction" }],
    },
  });
  for (const n of walkStatusNodes(resp.payload)) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(n, "reason"),
      `expected no 'reason' key on ${n.op}/${n.id}`,
    );
  }
});

// --- Access control --------------------------------------------------------

test("GET /proposals/{id} is readable by anyone (including null user)", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const submitted = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1 },
  });
  // Null caller:
  let res = await getProposal(app, submitted.id, null);
  assert.equal(res.status, 200);
  // Registered non-proposer caller:
  res = await getProposal(app, submitted.id, "alice");
  assert.equal(res.status, 200);
});

test("GET /proposals/{id} unknown id → 404", async () => {
  const app = await freshApp();
  const res = await getProposal(app, "p-bogus", null);
  assert.equal(res.status, 404);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "not_found");
});

test("GET /proposals/{id} malformed X-Username → 400", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const { id } = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1 },
  });
  // NBSP-prefixed name survives Hono's header normalization.
  const res = await app.request(`/proposals/${id}`, {
    headers: { "X-Username": " alice" },
  });
  assert.equal(res.status, 400);
});

// --- POST/GET round-trip (decision #6) -------------------------------------

test("POST /proposals body's payload equals subsequent GET's payload", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Fantasy")).id;
  await attach(app, "alice", r1, c1);
  const submitted: ProposalResponse = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c1, name: "Epic Fantasy" }],
    },
  });
  const res = await getProposal(app, submitted.id, null);
  assert.equal(res.status, 200);
  const fetched = (await res.json()) as ProposalResponse;
  assert.deepEqual(
    shapeNoChangeIds(submitted.payload),
    shapeNoChangeIds(fetched.payload),
  );
  // ChangeIds also stable across the two reads:
  assert.deepEqual(submitted.payload, fetched.payload);
});
