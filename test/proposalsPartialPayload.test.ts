// PRD §9.1 — partial-payload rule.
//
// "A payload taxon asserts something about itself and about the children
//  explicitly listed beneath it, and asserts NOTHING about any unlisted
//  children of the corresponding live taxon."

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  attach,
  createTaxon,
  freshApp,
  register,
  submitOk,
  walkStatusNodes,
} from "./proposalsTestHelpers.js";

test("listing only one of three children leaves the others unmentioned", async () => {
  // r1 (Alice) with three children c1, c2, c3 (all Alice). Payload
  // anchored at r1 mentions only c2 (no-op). c1 and c3 are not in the
  // status view; no change is produced about them.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "A")).id;
  const c2 = (await createTaxon(app, "alice", "B")).id;
  const c3 = (await createTaxon(app, "alice", "C")).id;
  await attach(app, "alice", r1, c1);
  await attach(app, "alice", r1, c2);
  await attach(app, "alice", r1, c3);

  const resp = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "no-op", id: c2 }],
    },
  });

  const nodes = walkStatusNodes(resp.payload);
  const taxonIds = nodes.map((n) => n.id);
  assert.deepEqual(taxonIds.sort(), [r1, c2].sort());
  assert.equal(nodes.filter((n) => n.op !== "no-op").length, 0);
});

test("partial payload + nested detach leaves siblings of the detach untouched in the change set", async () => {
  // r1 has child c2, which has children c2a, c2b. Payload anchors at r1,
  // descends to c2, and detaches c2a. c2b is unmentioned; no change is
  // produced about it.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c2 = (await createTaxon(app, "alice", "Fantasy")).id;
  const c2a = (await createTaxon(app, "alice", "Epic Fantasy")).id;
  const c2b = (await createTaxon(app, "alice", "Urban Fantasy")).id;
  await attach(app, "alice", r1, c2);
  await attach(app, "alice", c2, c2a);
  await attach(app, "alice", c2, c2b);

  const resp = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        {
          op: "no-op",
          id: c2,
          children: [{ op: "detach", id: c2a }],
        },
      ],
    },
  });
  const ops = walkStatusNodes(resp.payload).filter((n) => n.op !== "no-op");
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, "detach");
  assert.equal(ops[0].id, c2a);
  // c2b appears nowhere.
  const allIds = walkStatusNodes(resp.payload).map((n) => n.id);
  assert.ok(!allIds.includes(c2b));
});

test("listing a non-existent child is a 404, not 'partial' lenience", async () => {
  // The partial-payload rule means "you needn't mention unlisted siblings."
  // It does NOT mean you can mention a non-existent taxon. Submission
  // requires every payload id to exist (decision #3).
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c2 = (await createTaxon(app, "alice", "Fantasy")).id;
  await attach(app, "alice", r1, c2);

  const res = await (async () => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Username": "carol",
    };
    return app.request("/proposals", {
      method: "POST",
      headers,
      body: JSON.stringify({
        targetRootId: r1,
        topTaxonId: r1,
        payload: {
          op: "no-op",
          id: r1,
          children: [
            {
              op: "no-op",
              id: c2,
              children: [{ op: "no-op", id: "t-does-not-exist" }],
            },
          ],
        },
      }),
    });
  })();
  assert.equal(res.status, 404);
});
