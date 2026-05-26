// Phase-6 §15.5 authorization + state guards for accept and reject:
// identity middleware (null / unregistered / malformed), reviewer-match,
// queued-state requirement, and unknown-id 404.

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
  rejectChange,
  rejectOk,
  submitOk,
  type App,
} from "./proposalsTestHelpers.js";

const NBSP_USER = " alice"; // leading NBSP — malformed per §4

async function setupSimpleQueuedRename(app: App): Promise<string> {
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const sub = await submitOk(app, "bob", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "rename", id: r1, name: "Speculative Fiction" },
  });
  return sub.payload.changeId!;
}

for (const action of ["accept", "reject"] as const) {
  test(`${action}: null caller → 403 forbidden`, async () => {
    const app = await freshApp();
    const cid = await setupSimpleQueuedRename(app);
    const res = await app.request(`/changes/${cid}/${action}`, { method: "POST" });
    assert.equal(res.status, 403);
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.error.code, "forbidden");
  });

  test(`${action}: unregistered well-formed caller → 403`, async () => {
    const app = await freshApp();
    const cid = await setupSimpleQueuedRename(app);
    const res = await app.request(`/changes/${cid}/${action}`, {
      method: "POST",
      headers: { "X-Username": "stranger" },
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.error.code, "forbidden");
  });

  test(`${action}: malformed X-Username (NBSP-prefixed) → 400`, async () => {
    const app = await freshApp();
    const cid = await setupSimpleQueuedRename(app);
    const res = await app.request(`/changes/${cid}/${action}`, {
      method: "POST",
      headers: { "X-Username": NBSP_USER },
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.error.code, "validation_error");
  });

  test(`${action}: unknown change id → 404`, async () => {
    const app = await freshApp();
    await register(app, "alice");
    const res = await app.request(`/changes/c999/${action}`, {
      method: "POST",
      headers: { "X-Username": "alice" },
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.error.code, "not_found");
  });

  test(`${action}: registered non-reviewer → 403`, async () => {
    const app = await freshApp();
    const cid = await setupSimpleQueuedRename(app);
    // Bob (the proposer) is not the reviewer; reviewer is Alice.
    const res = await app.request(`/changes/${cid}/${action}`, {
      method: "POST",
      headers: { "X-Username": "bob" },
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.error.code, "forbidden");
  });
}

test("accept on an already-accepted change → 409", async () => {
  const app = await freshApp();
  const cid = await setupSimpleQueuedRename(app);
  await acceptOk(app, "alice", cid);
  const res = await acceptChange(app, "alice", cid);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "conflict");
  assert.equal(body.error.details?.kind, "change_not_queued");
  assert.equal(body.error.details?.state, "accepted");
});

test("reject on an already-rejected change → 409", async () => {
  const app = await freshApp();
  const cid = await setupSimpleQueuedRename(app);
  await rejectOk(app, "alice", cid);
  const res = await rejectChange(app, "alice", cid);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.details?.state, "rejected");
});

test("accept on a latent change → 409", async () => {
  // Latent change: a nested rename under an add-create that hasn't been
  // accepted. Routed (at submission time, since rename's reviewer is the
  // renamed taxon's owner) to Alice.
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
      children: [
        {
          op: "add",
          id: null,
          name: "Wrapper",
          children: [{ op: "rename", id: c1, name: "Speculative Fantasy" }],
        },
      ],
    },
  });
  const latentRenameId = sub.payload.children![0].children![0].changeId!;

  const res = await acceptChange(app, "alice", latentRenameId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.details?.state, "latent");
});

test("accept on an invalid change → 409", async () => {
  // Make a change invalid via reject-propagation, then try to accept it.
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
      children: [
        {
          op: "add",
          id: null,
          name: "Wrapper",
          children: [{ op: "rename", id: c1, name: "Speculative Fantasy" }],
        },
      ],
    },
  });
  const outerId = sub.payload.children![0].changeId!;
  const innerRenameId = sub.payload.children![0].children![0].changeId!;

  await rejectOk(app, "alice", outerId); // inner rename is now invalid.

  const res = await acceptChange(app, "alice", innerRenameId);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.details?.state, "invalid");
});
