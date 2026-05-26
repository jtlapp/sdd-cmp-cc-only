// Phase 7 — POST /changes/{id}/dismiss (§12.4, §15.5).
//
// Reviewer-only; only succeeds when the change is in the reviewer's
// queue AND state="invalid" (case 3). All other states/locations
// produce a §15.6 error.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  acceptOk,
  attach,
  createTaxon,
  dismiss,
  dismissOk,
  ErrorBody,
  freshApp,
  getQueue,
  QueueEntry,
  register,
  rejectOk,
  StatusNode,
  submitOk,
  walkStatusNodes,
  type App,
} from "./proposalsTestHelpers.js";

async function queueOf(app: App, who: string): Promise<QueueEntry[]> {
  const res = await getQueue(app, who);
  return ((await res.json()) as { changes: QueueEntry[] }).changes;
}

async function statusFor(app: App, proposalId: string): Promise<StatusNode> {
  const res = await app.request(`/proposals/${proposalId}`);
  return ((await res.json()) as { payload: StatusNode }).payload;
}

async function renameTaxon(
  app: App,
  caller: string,
  taxonId: string,
  newName: string,
) {
  const res = await app.request(`/taxa/${taxonId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Username": caller },
    body: JSON.stringify({ name: newName }),
  });
  assert.equal(res.status, 200);
}

// Helper: set up a case-3 invalid change in Alice's queue.
async function setupCase3Invalid(app: App) {
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Fantasy")).id;
  const c2 = (await createTaxon(app, "alice", "Mystery")).id;
  await attach(app, "alice", r1, c1);
  await attach(app, "alice", r1, c2);
  const sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c2, name: "Target" }],
    },
  });
  const changeId = sub.payload.children![0].changeId!;
  await renameTaxon(app, "alice", c1, "Target");
  // Trigger lazy detection.
  await queueOf(app, "alice");
  return { app, changeId, sub };
}

// --- Happy path -----------------------------------------------------------

test("dismiss happy path: case-3 invalid change → 200; removed from queue", async () => {
  const app = await freshApp();
  const { changeId, sub } = await setupCase3Invalid(app);

  const r = await dismissOk(app, "alice", changeId);
  assert.equal(r.changeId, changeId);
  assert.equal(r.state, "invalid");
  assert.equal(r.dismissed, true);

  // Not in queue.
  const aliceQ = await queueOf(app, "alice");
  assert.ok(!aliceQ.some((e) => e.changeId === changeId));
  // Still invalid in proposal view.
  const status = walkStatusNodes(await statusFor(app, sub.id));
  assert.equal(status.find((n) => n.changeId === changeId)?.disposition, "invalid");
});

// --- Negative paths -------------------------------------------------------

test("dismiss on a still-queued (still valid) change → 409 change_not_invalid", async () => {
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
      children: [{ op: "rename", id: c1, name: "Speculative Fantasy" }],
    },
  });
  const changeId = sub.payload.children![0].changeId!;

  const res = await dismiss(app, "alice", changeId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.details?.kind, "change_not_invalid");
  assert.equal(body.error.details?.state, "queued");
});

test("dismiss on a case-1 invalid (never queued) change → 409 change_not_in_queue", async () => {
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
          name: "Wrapper",
          children: [{ op: "add", id: null, name: "Inner" }],
        },
      ],
    },
  });
  const outerId = sub.payload.children![0].changeId!;
  const innerId = sub.payload.children![0].children![0].changeId!;

  // Reject the outer → inner becomes case-1 invalid (was latent, never queued).
  await rejectOk(app, "alice", outerId);

  const res = await dismiss(app, "alice", innerId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.details?.kind, "change_not_in_queue");
  assert.equal(body.error.details?.state, "invalid");
});

test("dismiss on a case-2 (already auto-dismissed) change → 409 change_not_in_queue", async () => {
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

  // Failed accept → case-2 auto-dismiss.
  await app.request(`/changes/${changeId}/accept`, {
    method: "POST",
    headers: { "X-Username": "alice" },
  });

  const res = await dismiss(app, "alice", changeId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.details?.kind, "change_not_in_queue");
});

test("dismiss on an accepted change → 409 change_not_invalid", async () => {
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
      children: [{ op: "rename", id: c1, name: "Speculative Fantasy" }],
    },
  });
  const changeId = sub.payload.children![0].changeId!;
  await acceptOk(app, "alice", changeId);

  const res = await dismiss(app, "alice", changeId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.details?.kind, "change_not_invalid");
  assert.equal(body.error.details?.state, "accepted");
});

test("dismiss on a rejected change → 409 change_not_invalid", async () => {
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
      children: [{ op: "rename", id: c1, name: "Speculative Fantasy" }],
    },
  });
  const changeId = sub.payload.children![0].changeId!;
  await rejectOk(app, "alice", changeId);

  const res = await dismiss(app, "alice", changeId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.details?.kind, "change_not_invalid");
  assert.equal(body.error.details?.state, "rejected");
});

// --- Auth + state guards (parameterized) ---------------------------------

test("dismiss auth: null caller → 403", async () => {
  const app = await freshApp();
  const { changeId } = await setupCase3Invalid(app);
  const res = await dismiss(app, null, changeId);
  assert.equal(res.status, 403);
});

test("dismiss auth: unregistered caller → 403", async () => {
  const app = await freshApp();
  const { changeId } = await setupCase3Invalid(app);
  const res = await dismiss(app, "stranger", changeId);
  assert.equal(res.status, 403);
});

test("dismiss auth: malformed X-Username (NBSP-prefixed) → 400", async () => {
  const app = await freshApp();
  const { changeId } = await setupCase3Invalid(app);
  const res = await app.request(`/changes/${changeId}/dismiss`, {
    method: "POST",
    headers: { "X-Username": " alice" },
  });
  assert.equal(res.status, 400);
});

test("dismiss on unknown change id → 404", async () => {
  const app = await freshApp();
  await register(app, "alice");
  const res = await dismiss(app, "alice", "c99999");
  assert.equal(res.status, 404);
});

test("dismiss as non-reviewer → 403", async () => {
  const app = await freshApp();
  const { changeId } = await setupCase3Invalid(app);
  await register(app, "carol");
  const res = await dismiss(app, "carol", changeId);
  assert.equal(res.status, 403);
});

test("dismiss is idempotent in effect but not in state: second dismiss → 409 change_not_in_queue", async () => {
  const app = await freshApp();
  const { changeId } = await setupCase3Invalid(app);
  await dismissOk(app, "alice", changeId);
  const res = await dismiss(app, "alice", changeId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.details?.kind, "change_not_in_queue");
});
