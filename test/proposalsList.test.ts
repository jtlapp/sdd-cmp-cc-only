// PRD §15.2 — GET /proposals list endpoint with optional proposer filter.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createTaxon,
  freshApp,
  listProposals,
  register,
  submitOk,
} from "./proposalsTestHelpers.js";

type Summary = {
  id: string;
  proposer: string;
  targetRootId: string;
  topTaxonId: string;
};

test("GET /proposals: empty server → empty list", async () => {
  const app = await freshApp();
  const res = await listProposals(app);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { proposals: [] });
});

test("GET /proposals: one proposal → one summary", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const submitted = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1 },
  });
  const res = await listProposals(app);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { proposals: Summary[] };
  assert.equal(body.proposals.length, 1);
  assert.equal(body.proposals[0].id, submitted.id);
  assert.equal(body.proposals[0].proposer, "carol");
  assert.equal(body.proposals[0].targetRootId, r1);
  assert.equal(body.proposals[0].topTaxonId, r1);
});

test("GET /proposals: multiple proposals in submission order", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const r2 = (await createTaxon(app, "bob", "Genre Index")).id;
  const p1 = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1 },
  });
  const p2 = await submitOk(app, "carol", {
    targetRootId: r2,
    topTaxonId: r2,
    payload: { op: "no-op", id: r2 },
  });
  const p3 = await submitOk(app, "alice", {
    targetRootId: r2,
    topTaxonId: r2,
    payload: { op: "no-op", id: r2 },
  });
  const res = await listProposals(app);
  const body = (await res.json()) as { proposals: Summary[] };
  assert.deepEqual(
    body.proposals.map((s) => s.id),
    [p1.id, p2.id, p3.id],
  );
});

test("GET /proposals?proposer=alice → only Alice's proposals", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1 },
  });
  const alices = await submitOk(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1 },
  });
  const res = await listProposals(app, null, "alice");
  const body = (await res.json()) as { proposals: Summary[] };
  assert.equal(body.proposals.length, 1);
  assert.equal(body.proposals[0].id, alices.id);
});

test("GET /proposals?proposer=ALICE → case-insensitive via registry canonical form", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "Alice", "Fiction")).id;
  await submitOk(app, "Alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1 },
  });
  const res = await listProposals(app, null, "alice");
  const body = (await res.json()) as { proposals: Summary[] };
  assert.equal(body.proposals.length, 1);
  assert.equal(body.proposals[0].proposer, "Alice"); // canonical casing preserved
});

test("GET /proposals?proposer=unregistered → empty list (decision #10)", async () => {
  const app = await freshApp();
  await register(app, "alice");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  await submitOk(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1 },
  });
  const res = await listProposals(app, null, "stranger");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { proposals: Summary[] };
  assert.deepEqual(body.proposals, []);
});

test("GET /proposals: null caller may read", async () => {
  const app = await freshApp();
  const res = await listProposals(app, null);
  assert.equal(res.status, 200);
});

test("GET /proposals: malformed X-Username → 400", async () => {
  const app = await freshApp();
  const res = await app.request("/proposals", {
    headers: { "X-Username": " alice" },
  });
  assert.equal(res.status, 400);
});
