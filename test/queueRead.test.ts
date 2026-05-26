// PRD §15.2 — GET /queue.
//
// Lists the calling user's currently queued changes across all proposals.
// Phase 5: only the "queued" state is reachable; invalid-awaiting-dismiss
// is unreachable until Phase 7.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  attach,
  createTaxon,
  ErrorBody,
  freshApp,
  getQueue,
  QueueEntry,
  register,
  submitOk,
} from "./proposalsTestHelpers.js";

async function queueOf(app: Awaited<ReturnType<typeof freshApp>>, who: string | null) {
  const res = await getQueue(app, who);
  return { status: res.status, body: await res.json() };
}

// --- Auth shape ------------------------------------------------------------

test("GET /queue: null caller → 200, empty list", async () => {
  const app = await freshApp();
  const r = await queueOf(app, null);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { changes: [] });
});

test("GET /queue: unregistered → 403", async () => {
  const app = await freshApp();
  const res = await getQueue(app, "stranger");
  assert.equal(res.status, 403);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "forbidden");
});

test("GET /queue: malformed X-Username → 400", async () => {
  const app = await freshApp();
  const res = await app.request("/queue", { headers: { "X-Username": " alice" } });
  assert.equal(res.status, 400);
});

test("GET /queue: registered caller with no incoming changes → empty list", async () => {
  const app = await freshApp();
  await register(app, "alice");
  const r = await queueOf(app, "alice");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { changes: [] });
});

// --- Single queued change rendering ---------------------------------------

test("GET /queue: queued rename entry shape", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "bob", "Fantasy")).id;
  await attach(app, "alice", r1, c1);
  const submitted = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c1, name: "Epic Fantasy" }],
    },
  });
  const r = await queueOf(app, "bob");
  assert.equal(r.status, 200);
  const body = r.body as { changes: QueueEntry[] };
  assert.equal(body.changes.length, 1);
  const entry = body.changes[0];
  assert.equal(entry.proposalId, submitted.id);
  assert.equal(entry.op, "rename");
  assert.equal(entry.targetRootId, r1);
  assert.equal(entry.taxonId, c1);
  assert.equal(entry.name, "Epic Fantasy");
  assert.equal(entry.payloadParentTaxonId, undefined);
  assert.equal(entry.state, "queued");
});

test("GET /queue: queued add-create entry shape (no taxonId, has name + parent)", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", id: null, name: "Speculative Fiction" }],
    },
  });
  const r = await queueOf(app, "alice");
  const body = r.body as { changes: QueueEntry[] };
  assert.equal(body.changes.length, 1);
  const e = body.changes[0];
  assert.equal(e.op, "add");
  assert.equal(e.name, "Speculative Fiction");
  assert.equal(e.payloadParentTaxonId, r1);
  assert.equal(e.taxonId, undefined);
  assert.equal(e.state, "queued");
});

test("GET /queue: queued add-graft entry shape (taxonId + parent, no name)", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const orphan = (await createTaxon(app, "bob", "Mystery")).id;
  await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", id: orphan }],
    },
  });
  const r = await queueOf(app, "alice");
  const body = r.body as { changes: QueueEntry[] };
  assert.equal(body.changes.length, 1);
  const e = body.changes[0];
  assert.equal(e.op, "add");
  assert.equal(e.taxonId, orphan);
  assert.equal(e.payloadParentTaxonId, r1);
  assert.equal(e.name, undefined);
});

test("GET /queue: queued detach entry shape (taxonId + parent, no name)", async () => {
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
      children: [{ op: "detach", id: c1 }],
    },
  });
  const r = await queueOf(app, "alice");
  const body = r.body as { changes: QueueEntry[] };
  const e = body.changes[0];
  assert.equal(e.op, "detach");
  assert.equal(e.taxonId, c1);
  assert.equal(e.payloadParentTaxonId, r1);
  assert.equal(e.name, undefined);
});

// --- Multi-reviewer no-cross-talk ------------------------------------------

test("GET /queue: routed changes appear only in their reviewer's queue", async () => {
  // §10.1 keystone — rename of c2 routes to Bob (owner); add nested under
  // c2 also routes to Bob. Alice (parent owner) sees nothing. Carol
  // (proposer) sees nothing.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c2 = (await createTaxon(app, "bob", "Fantasy")).id;
  await attach(app, "alice", r1, c2);
  await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        {
          op: "rename",
          id: c2,
          name: "Renamed Fantasy",
          children: [{ op: "add", id: null, name: "Urban Fantasy" }],
        },
      ],
    },
  });
  const aliceBody = (await queueOf(app, "alice")).body as { changes: QueueEntry[] };
  const bobBody = (await queueOf(app, "bob")).body as { changes: QueueEntry[] };
  const carolBody = (await queueOf(app, "carol")).body as { changes: QueueEntry[] };
  assert.equal(aliceBody.changes.length, 0);
  assert.equal(bobBody.changes.length, 2);
  assert.equal(carolBody.changes.length, 0);
});

// --- Latent changes never appear -------------------------------------------

test("GET /queue: latent changes are never in any queue", async () => {
  // Appendix A.1 shape — Paranormal Romance is latent under Urban Fantasy.
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
  await submitOk(app, "carol", {
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
  const all: QueueEntry[] = [];
  for (const who of ["alice", "bob", "carol"]) {
    const b = (await queueOf(app, who)).body as { changes: QueueEntry[] };
    all.push(...b.changes);
  }
  // 3 queued changes; nothing about "Paranormal Romance".
  assert.equal(all.length, 3);
  assert.ok(!all.some((e) => e.name === "Paranormal Romance"));
});

// --- Queue ordering (decision #11) -----------------------------------------

test("GET /queue: entries ordered by change-id (submission order)", async () => {
  // Two proposals in the same caller's queue submitted sequentially —
  // the second proposal's change-id is higher.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  // Two single-rename proposals targeting Alice's own taxon (queue goes
  // to Alice each time). Use renames of two distinct children to keep
  // schema valid.
  const c1 = (await createTaxon(app, "alice", "A")).id;
  const c2 = (await createTaxon(app, "alice", "B")).id;
  await attach(app, "alice", r1, c1);
  await attach(app, "alice", r1, c2);
  await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c1, name: "Aprime" }],
    },
  });
  await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c2, name: "Bprime" }],
    },
  });
  const r = await queueOf(app, "alice");
  const body = r.body as { changes: QueueEntry[] };
  assert.equal(body.changes.length, 2);
  // c1 < c2 by submission order; entries should appear in that order.
  const ids = body.changes.map((e) => e.changeId);
  const sorted = [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  assert.deepEqual(ids, sorted);
});
