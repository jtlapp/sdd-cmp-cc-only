// PRD §15 — POST /reset clears all proposal state introduced by Phase 5.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  attach,
  createTaxon,
  freshApp,
  getQueue,
  listProposals,
  postProposal,
  ProposalResponse,
  QueueEntry,
  register,
  submitOk,
} from "./proposalsTestHelpers.js";

test("POST /reset clears the proposals registry", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1 },
  });
  await app.request("/reset", { method: "POST" });
  const res = await listProposals(app, null);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { proposals: [] });
});

test("POST /reset clears every reviewer's queue", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Fantasy")).id;
  await attach(app, "alice", r1, c1);
  await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c1, name: "Epic Fantasy" }],
    },
  });
  // Pre-reset Alice has a queued change.
  let qres = await getQueue(app, "alice");
  let qbody = (await qres.json()) as { changes: QueueEntry[] };
  assert.equal(qbody.changes.length, 1);

  await app.request("/reset", { method: "POST" });

  // Post-reset Alice (after re-registering) sees nothing.
  await register(app, "alice");
  qres = await getQueue(app, "alice");
  qbody = (await qres.json()) as { changes: QueueEntry[] };
  assert.deepEqual(qbody.changes, []);
});

test("POST /reset restarts the change-id counter at c1 (and the proposal-id counter at p1)", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  let r1 = (await createTaxon(app, "alice", "Fiction")).id;
  let resp: ProposalResponse = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", id: null, name: "Speculative Fiction" }],
    },
  });
  const firstChangeId = resp.payload.children![0].changeId!;
  const firstProposalId = resp.id;

  await app.request("/reset", { method: "POST" });
  await register(app, "alice");
  await register(app, "carol");
  r1 = (await createTaxon(app, "alice", "Fiction")).id;
  resp = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", id: null, name: "Speculative Fiction" }],
    },
  });
  // The new change/proposal ids match the pre-reset first ids —
  // counters restarted.
  assert.equal(resp.id, firstProposalId);
  assert.equal(resp.payload.children![0].changeId, firstChangeId);
});

test("POST /reset is still §4-exempt (null caller may invoke it)", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1 },
  });
  // Null caller — no X-Username header.
  const res = await app.request("/reset", { method: "POST" });
  assert.equal(res.status, 204);
  // State is gone.
  const list = await listProposals(app, null);
  assert.deepEqual(await list.json(), { proposals: [] });
});

test("POST /reset is §4-exempt for malformed-header callers too", async () => {
  const app = await freshApp();
  const res = await app.request("/reset", {
    method: "POST",
    headers: { "X-Username": " malformed" },
  });
  assert.equal(res.status, 204);
});

// --- Sanity: post-reset a brand-new proposal works end-to-end -------------

test("post-reset the new proposal subsystem is fully usable", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  await app.request("/reset", { method: "POST" });
  // Everything's gone. Re-bootstrap and submit afresh.
  await register(app, "alice");
  await register(app, "carol");
  const r1b = (await createTaxon(app, "alice", "Fiction")).id;
  void r1;
  const res = await postProposal(app, "carol", {
    targetRootId: r1b,
    topTaxonId: r1b,
    payload: { op: "no-op", id: r1b },
  });
  assert.equal(res.status, 201);
});
