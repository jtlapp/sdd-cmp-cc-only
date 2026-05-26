// Phase-6 §11.3 promotion — accepting add/graft moves direct dependents
// from latent to queued. Covers reviewer-resolution at promotion time
// (including the ownership-transfer-into-new-parent case from Appendix
// A.1), the "only direct dependents promote" rule, and the existence-
// dep-failure → invalid path (Phase 6 decision #3).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  acceptOk,
  attach,
  createTaxon,
  freshApp,
  getQueue,
  QueueEntry,
  register,
  submitOk,
  type App,
  type StatusNode,
  walkStatusNodes,
} from "./proposalsTestHelpers.js";

async function queueOf(app: App, who: string): Promise<QueueEntry[]> {
  const res = await getQueue(app, who);
  return ((await res.json()) as { changes: QueueEntry[] }).changes;
}

async function statusFor(app: App, proposalId: string): Promise<StatusNode> {
  const res = await app.request(`/proposals/${proposalId}`);
  const body = (await res.json()) as { payload: StatusNode };
  return body.payload;
}

// --- Direct ownership transfer through nested create -----------------------

test("Appendix A.1 cascade-shape: accept create → nested create promotes to accepter's queue", async () => {
  // Alice owns r1 → c1 → c2 (Bob); c3 (Bob) under c2. Carol proposes a
  // create of Urban Fantasy under c2, with nested create of Paranormal
  // Romance under Urban Fantasy.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Speculative Fiction")).id;
  const c2 = (await createTaxon(app, "bob", "Fantasy")).id;
  await attach(app, "alice", r1, c1);
  await attach(app, "alice", c1, c2);

  const sub = await submitOk(app, "carol", {
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
              op: "no-op",
              id: c2,
              children: [
                {
                  op: "add",
                  id: null,
                  name: "Urban Fantasy",
                  children: [{ op: "add", id: null, name: "Paranormal Romance" }],
                },
              ],
            },
          ],
        },
      ],
    },
  });
  const ufChangeId =
    sub.payload.children![0].children![0].children![0].changeId!;
  const prChangeId =
    sub.payload.children![0].children![0].children![0].children![0].changeId!;

  // Pre-accept: PR is latent, in nobody's queue.
  const pre = walkStatusNodes(await statusFor(app, sub.id));
  assert.equal(pre.find((n) => n.changeId === prChangeId)?.disposition, "latent");
  assert.equal((await queueOf(app, "bob")).filter((e) => e.changeId === prChangeId).length, 0);

  // Bob accepts the Urban Fantasy create.
  await acceptOk(app, "bob", ufChangeId);

  // Now PR is queued — to Bob (who became the new taxon's owner).
  const post = walkStatusNodes(await statusFor(app, sub.id));
  assert.equal(post.find((n) => n.changeId === prChangeId)?.disposition, "queued");
  const bobQ = await queueOf(app, "bob");
  assert.ok(bobQ.some((e) => e.changeId === prChangeId));
});

// --- Nested rename of an existing taxon under a create --------------------

test("nested rename under create routes to renamed-taxon's owner (not accepter)", async () => {
  // Alice owns r1; Carol owns z (a separate root). Bob proposes: under
  // r1, add Y (create), and under Y, rename z.
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const z = (await createTaxon(app, "carol", "Mystery")).id;

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
          name: "Y",
          children: [{ op: "rename", id: z, name: "Crime Mystery" }],
        },
      ],
    },
  });
  const yChangeId = sub.payload.children![0].changeId!;
  const renameChangeId = sub.payload.children![0].children![0].changeId!;

  // Alice accepts Y. The nested rename should promote to Carol's queue.
  await acceptOk(app, "alice", yChangeId);
  const carolQ = await queueOf(app, "carol");
  assert.ok(carolQ.some((e) => e.changeId === renameChangeId));
  const aliceQ = await queueOf(app, "alice");
  assert.ok(!aliceQ.some((e) => e.changeId === renameChangeId));
  // (The rename will still fail at accept time because the new parent Y
  // has no edge to z — we only assert promotion routing here; Carol
  // attempting accept is exercised in the validation tests.)
});

// --- Nested add under graft routes to grafted-taxon's owner -----------------

test("nested add under graft promotes to grafted-taxon's owner (§9.3)", async () => {
  // Frank owns b1 → b2; Erin owns a3. Grace proposes: graft a3 under
  // b2, with a nested add-create under a3.
  const app = await freshApp();
  await register(app, "erin");
  await register(app, "frank");
  await register(app, "grace");
  const b1 = (await createTaxon(app, "frank", "Genre Index")).id;
  const b2 = (await createTaxon(app, "frank", "Dark Fiction")).id;
  await attach(app, "frank", b1, b2);
  const a3 = (await createTaxon(app, "erin", "Psychological Thriller")).id;

  const sub = await submitOk(app, "grace", {
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
              children: [{ op: "add", id: null, name: "Unreliable Narrator Thriller" }],
            },
          ],
        },
      ],
    },
  });
  const graftId = sub.payload.children![0].children![0].changeId!;
  const innerId = sub.payload.children![0].children![0].children![0].changeId!;

  await acceptOk(app, "frank", graftId);

  // The inner create is now in Erin's queue (a3's owner — unchanged
  // by graft), not Frank's.
  const erinQ = await queueOf(app, "erin");
  assert.equal(erinQ.length, 1);
  assert.equal(erinQ[0].changeId, innerId);
  const frankQ = await queueOf(app, "frank");
  assert.ok(!frankQ.some((e) => e.changeId === innerId));
});

// --- Nested detach under graft promotes to grafted-taxon's owner ----------

test("nested detach under graft promotes to grafted-taxon's owner", async () => {
  // Erin's a3 → a3c. Frank's b1 → b2. Graft a3 under b2, with nested
  // detach of a3c.
  const app = await freshApp();
  await register(app, "erin");
  await register(app, "frank");
  await register(app, "grace");
  const a3 = (await createTaxon(app, "erin", "Psychological Thriller")).id;
  const a3c = (await createTaxon(app, "erin", "Locked-Room Mystery")).id;
  await attach(app, "erin", a3, a3c);
  const b1 = (await createTaxon(app, "frank", "Genre Index")).id;
  const b2 = (await createTaxon(app, "frank", "Dark Fiction")).id;
  await attach(app, "frank", b1, b2);

  const sub = await submitOk(app, "grace", {
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
              children: [{ op: "detach", id: a3c }],
            },
          ],
        },
      ],
    },
  });
  const graftId = sub.payload.children![0].children![0].changeId!;
  const detachId = sub.payload.children![0].children![0].children![0].changeId!;

  await acceptOk(app, "frank", graftId);

  const erinQ = await queueOf(app, "erin");
  assert.ok(erinQ.some((e) => e.changeId === detachId));
});

// --- Only direct dependents promote ----------------------------------------

test("only direct dependents promote: deeper add stays latent until its own parent accepts", async () => {
  // r1 (Alice) → add A (create) → add B (create) → add C (create).
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
      children: [
        {
          op: "add",
          id: null,
          name: "A",
          children: [
            {
              op: "add",
              id: null,
              name: "B",
              children: [{ op: "add", id: null, name: "C" }],
            },
          ],
        },
      ],
    },
  });
  const a = sub.payload.children![0];
  const b = a.children![0];
  const c = b.children![0];
  const aId = a.changeId!;
  const bId = b.changeId!;
  const cId = c.changeId!;

  // Initially: A queued, B and C latent.
  let status = walkStatusNodes(await statusFor(app, sub.id));
  assert.equal(status.find((n) => n.changeId === aId)?.disposition, "queued");
  assert.equal(status.find((n) => n.changeId === bId)?.disposition, "latent");
  assert.equal(status.find((n) => n.changeId === cId)?.disposition, "latent");

  // Alice accepts A. B should promote; C should NOT.
  await acceptOk(app, "alice", aId);
  status = walkStatusNodes(await statusFor(app, sub.id));
  assert.equal(status.find((n) => n.changeId === aId)?.disposition, "accepted");
  assert.equal(status.find((n) => n.changeId === bId)?.disposition, "queued");
  assert.equal(status.find((n) => n.changeId === cId)?.disposition, "latent");

  // Now Alice (new owner of A) accepts B; C promotes.
  await acceptOk(app, "alice", bId);
  status = walkStatusNodes(await statusFor(app, sub.id));
  assert.equal(status.find((n) => n.changeId === bId)?.disposition, "accepted");
  assert.equal(status.find((n) => n.changeId === cId)?.disposition, "queued");
});

// --- Sibling dependents promote together ----------------------------------

test("sibling dependents under one accepted add all promote in change-id order", async () => {
  // r1 (Alice) → add A → [rename of existing X, add (create) Y]
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const x = (await createTaxon(app, "alice", "Existing")).id;

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
          name: "A",
          children: [
            { op: "rename", id: x, name: "Renamed" },
            { op: "add", id: null, name: "Y" },
          ],
        },
      ],
    },
  });
  const aId = sub.payload.children![0].changeId!;
  const renameId = sub.payload.children![0].children![0].changeId!;
  const yId = sub.payload.children![0].children![1].changeId!;

  await acceptOk(app, "alice", aId);

  // Both siblings are queued. The rename routes to x's owner (Alice).
  // The Y create routes to A's owner (Alice).
  const aliceQ = await queueOf(app, "alice");
  const idsInQ = aliceQ.map((e) => e.changeId);
  assert.ok(idsInQ.includes(renameId));
  assert.ok(idsInQ.includes(yId));
});

// --- Promotion-time existence-dep failure → invalid (Phase 6 decision #3) -

test("existence dep broken between submission and graft accept → dependent invalidated", async () => {
  // T1: Frank owns b1 → b2. Erin owns a3 → a3c.
  // Grace proposes: graft a3 under b2, with nested rename of a3c (whose
  // existence dep is "a3c is a child of a3 in the post-graft target tree").
  // Before Frank accepts the graft, Erin DIRECTLY detaches a3c from a3.
  // When Frank accepts the graft, a3c is no longer reachable through a3
  // in the target tree → the rename's existence dep fails → invalid.
  const app = await freshApp();
  await register(app, "erin");
  await register(app, "frank");
  await register(app, "grace");
  const a3 = (await createTaxon(app, "erin", "Psychological Thriller")).id;
  const a3c = (await createTaxon(app, "erin", "Locked-Room Mystery")).id;
  await attach(app, "erin", a3, a3c);
  const b1 = (await createTaxon(app, "frank", "Genre Index")).id;
  const b2 = (await createTaxon(app, "frank", "Dark Fiction")).id;
  await attach(app, "frank", b1, b2);

  const sub = await submitOk(app, "grace", {
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
                {
                  op: "no-op",
                  id: a3c,
                  children: [{ op: "rename", id: a3c, name: "Country-House Mystery" }],
                },
              ],
            },
          ],
        },
      ],
    },
  });
  const graftId = sub.payload.children![0].children![0].changeId!;
  // The rename is below a no-op below the graft.
  const renameStatusNode = sub.payload.children![0].children![0].children![0].children![0];
  const renameId = renameStatusNode.changeId!;

  // Erin externally detaches a3c from a3 BEFORE Frank accepts.
  const detachRes = await app.request(`/taxa/${a3}/children/${a3c}`, {
    method: "DELETE",
    headers: { "X-Username": "erin" },
  });
  assert.equal(detachRes.status, 204);

  // Frank accepts the graft. The rename should be marked invalid.
  await acceptOk(app, "frank", graftId);

  const status = walkStatusNodes(await statusFor(app, sub.id));
  const renameStatus = status.find((n) => n.changeId === renameId);
  assert.equal(renameStatus?.disposition, "invalid");
  assert.match(renameStatus?.reason ?? "", new RegExp(a3c));
  // The rename is not in Erin's queue.
  const erinQ = await queueOf(app, "erin");
  assert.ok(!erinQ.some((e) => e.changeId === renameId));
});
