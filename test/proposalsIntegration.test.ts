// Phase-5 integration — multi-step end-to-end stories tying earlier
// phases plus proposal submission to verify the phase composes correctly.
// Stops short of acceptance (Phase 6+).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  attach,
  createTaxon,
  freshApp,
  getQueue,
  listProposals,
  ProposalResponse,
  QueueEntry,
  register,
  submitOk,
  walkStatusNodes,
} from "./proposalsTestHelpers.js";

async function queueOf(app: Awaited<ReturnType<typeof freshApp>>, who: string) {
  const res = await getQueue(app, who);
  return ((await res.json()) as { changes: QueueEntry[] }).changes;
}

// --- Appendix A.1 walkthrough up to submission -----------------------------

test("Appendix A.1: routing across Alice/Bob; latent change not in any queue", async () => {
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

  const aliceQ = await queueOf(app, "alice");
  const bobQ = await queueOf(app, "bob");
  const carolQ = await queueOf(app, "carol");

  // Alice: the c1 rename.
  assert.equal(aliceQ.length, 1);
  assert.equal(aliceQ[0].op, "rename");
  assert.equal(aliceQ[0].taxonId, c1);
  // Bob: the c3 rename + the Urban Fantasy create. Order = submission =
  // change-id ascending.
  assert.equal(bobQ.length, 2);
  assert.deepEqual(
    bobQ.map((e) => e.op).sort(),
    ["add", "rename"],
  );
  // Carol: nothing.
  assert.equal(carolQ.length, 0);

  // Paranormal Romance is latent in the status view but in nobody's queue.
  const paranormal = walkStatusNodes(resp.payload).find(
    (n) => n.name === "Paranormal Romance",
  )!;
  assert.equal(paranormal.disposition, "latent");
  for (const who of ["alice", "bob", "carol"]) {
    const q = await queueOf(app, who);
    assert.ok(!q.some((e) => e.changeId === paranormal.changeId));
  }
});

// --- Appendix A.2 two-proposal cross-tree move (submission only) ----------

test("Appendix A.2: two independent proposals for a cross-tree move", async () => {
  const app = await freshApp();
  await register(app, "dana");
  await register(app, "erin");
  await register(app, "frank");
  await register(app, "grace");
  // T1: a1 (Dana) → a2 (Dana) → a3 (Erin)
  const a1 = (await createTaxon(app, "dana", "Suspense and Discovery Fiction")).id;
  const a2 = (await createTaxon(app, "dana", "Thriller")).id;
  const a3 = (await createTaxon(app, "erin", "Psychological Thriller")).id;
  await attach(app, "dana", a1, a2);
  await attach(app, "dana", a2, a3);
  // T2: b1 (Frank) → b2 (Frank)
  const b1 = (await createTaxon(app, "frank", "Genre Index")).id;
  const b2 = (await createTaxon(app, "frank", "Dark Fiction")).id;
  await attach(app, "frank", b1, b2);

  // P1: detach a3 from a2 (target T1).
  const p1 = await submitOk(app, "grace", {
    targetRootId: a1,
    topTaxonId: a1,
    payload: {
      op: "no-op",
      id: a1,
      children: [
        {
          op: "no-op",
          id: a2,
          children: [{ op: "detach", id: a3 }],
        },
      ],
    },
  });
  // P2: graft a3 under b2 with nested create (target T2).
  const p2: ProposalResponse = await submitOk(app, "grace", {
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

  // Dana's queue contains P1's detach.
  const danaQ = await queueOf(app, "dana");
  assert.equal(danaQ.length, 1);
  assert.equal(danaQ[0].proposalId, p1.id);
  assert.equal(danaQ[0].op, "detach");

  // Frank's queue contains P2's graft.
  const frankQ = await queueOf(app, "frank");
  assert.equal(frankQ.length, 1);
  assert.equal(frankQ[0].proposalId, p2.id);
  assert.equal(frankQ[0].op, "add");
  assert.equal(frankQ[0].taxonId, a3);

  // Erin's queue is empty — the nested create is latent on the graft.
  const erinQ = await queueOf(app, "erin");
  assert.equal(erinQ.length, 0);

  // Both proposals appear in the list — they're independent (§14 bullet 1
  // structural independence: no shared dependency, separate proposal IDs).
  const list = await listProposals(app, null);
  const body = (await list.json()) as { proposals: { id: string }[] };
  assert.deepEqual(
    body.proposals.map((s) => s.id).sort(),
    [p1.id, p2.id].sort(),
  );
});

// --- Self-routed proposal --------------------------------------------------

test("self-routed proposal: change appears in proposer's own queue", async () => {
  const app = await freshApp();
  await register(app, "alice");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Fantasy")).id;
  await attach(app, "alice", r1, c1);
  await submitOk(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c1, name: "Epic Fantasy" }],
    },
  });
  const q = await queueOf(app, "alice");
  assert.equal(q.length, 1);
  assert.equal(q[0].op, "rename");
});

// --- Reset across the lifecycle --------------------------------------------

test("reset across the lifecycle: ids restart, no pre-reset residue", async () => {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "carol");
  let r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const first = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", id: null, name: "X" }],
    },
  });
  // Confirm pre-reset state exists.
  let list = await listProposals(app, null);
  assert.equal(((await list.json()) as { proposals: unknown[] }).proposals.length, 1);

  // Reset and rebuild.
  await app.request("/reset", { method: "POST" });
  await register(app, "alice");
  await register(app, "carol");
  r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const second = await submitOk(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", id: null, name: "X" }],
    },
  });
  assert.equal(second.id, first.id); // p-id counter restart
  assert.equal(
    second.payload.children![0].changeId,
    first.payload.children![0].changeId,
  ); // c-id counter restart
  // No residue: only the one fresh proposal is visible.
  list = await listProposals(app, null);
  const body = (await list.json()) as { proposals: { id: string }[] };
  assert.equal(body.proposals.length, 1);
  assert.equal(body.proposals[0].id, second.id);
});
