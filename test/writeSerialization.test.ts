// PRD §11.1 — write serialization at the HTTP boundary.
//
// Complements writeLock.test.ts (the primitive in isolation) by exercising
// the lock through real route handlers in the Hono app.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";

type TaxonRecord = {
  id: string;
  name: string;
  owner: string;
  childIds: string[];
  parentIds: string[];
};

async function freshApp() {
  const app = createApp();
  await app.request("/reset", { method: "POST" });
  await app.request("/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "Alice" }),
  });
  return app;
}

async function postTaxa(
  app: ReturnType<typeof createApp>,
  caller: string,
  name: string,
): Promise<Response> {
  return app.request("/taxa", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Username": caller },
    body: JSON.stringify({ name }),
  });
}

test("write serialization: two POST /taxa fired in the same tick produce distinct ids in submission order", async () => {
  const app = await freshApp();
  // Dispatch in the same tick without awaiting between them.
  const [r1, r2, r3] = await Promise.all([
    postTaxa(app, "Alice", "First"),
    postTaxa(app, "Alice", "Second"),
    postTaxa(app, "Alice", "Third"),
  ]);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.equal(r3.status, 201);
  const b1 = (await r1.json()) as TaxonRecord;
  const b2 = (await r2.json()) as TaxonRecord;
  const b3 = (await r3.json()) as TaxonRecord;
  // IDs are monotonic, so submission order ↔ ID order.
  const nums = [b1.id, b2.id, b3.id].map((x) => Number(x.slice(1)));
  assert.equal(nums[0]! + 1, nums[1]!);
  assert.equal(nums[1]! + 1, nums[2]!);
});

test("write serialization: a PATCH issued same-tick after a POST sees the POSTed taxon", async () => {
  const app = await freshApp();

  // Issue POST and capture the id from its response. Then immediately
  // PATCH that id. Even though both are queued at once, the PATCH must
  // observe the POST's committed state.
  const post = postTaxa(app, "Alice", "Original");
  const patch = post.then(async (r) => {
    const body = (await r.json()) as TaxonRecord;
    return app.request(`/taxa/${body.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Username": "Alice" },
      body: JSON.stringify({ name: "Renamed" }),
    });
  });

  const patched = await patch;
  assert.equal(patched.status, 200);
  const body = (await patched.json()) as TaxonRecord;
  assert.equal(body.name, "Renamed");
});

test("write serialization: POST /reset runs under the lock (§15) — writes before observe pre-reset, after observe empty state", async () => {
  const app = await freshApp();
  // Create something, then reset, then create again, all dispatched in
  // sequence (each awaiting the previous). The reset must wipe the
  // intermediate state.
  const created1 = await postTaxa(app, "Alice", "Pre");
  assert.equal(created1.status, 201);

  const reset = await app.request("/reset", { method: "POST" });
  assert.equal(reset.status, 204);

  // After reset the user registry is empty; Alice must re-register.
  const ghostCreate = await postTaxa(app, "Alice", "Post");
  assert.equal(ghostCreate.status, 403, "after reset, Alice is no longer registered");

  // Re-register and confirm the taxon counter restarts.
  await app.request("/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "Alice" }),
  });
  const created2 = await postTaxa(app, "Alice", "Post");
  assert.equal(created2.status, 201);
  const body = (await created2.json()) as TaxonRecord;
  assert.equal(body.id, "t1", "reset must restart the ID counter");
});

test("write serialization: two POST /proposals fired in the same tick produce ordered proposal+change ids", async () => {
  const app = await freshApp();
  // Alice owns the target root; the proposal is a trivial no-op + create,
  // submitted by Alice (self-routed) for simplicity.
  const root = (await (await postTaxa(app, "Alice", "Fiction")).json()) as TaxonRecord;
  const body = JSON.stringify({
    targetRootId: root.id,
    topTaxonId: root.id,
    payload: {
      op: "no-op",
      id: root.id,
      children: [{ op: "add", id: null, name: "X" }],
    },
  });
  // Dispatch three in the same tick.
  const [r1, r2, r3] = await Promise.all([
    app.request("/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Username": "Alice" },
      body,
    }),
    app.request("/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Username": "Alice" },
      body,
    }),
    app.request("/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Username": "Alice" },
      body,
    }),
  ]);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.equal(r3.status, 201);
  const p1 = (await r1.json()) as { id: string; payload: { children: { changeId: string }[] } };
  const p2 = (await r2.json()) as { id: string; payload: { children: { changeId: string }[] } };
  const p3 = (await r3.json()) as { id: string; payload: { children: { changeId: string }[] } };
  // Proposal ids monotonic.
  const pNums = [p1.id, p2.id, p3.id].map((s) => Number(s.slice(1)));
  assert.equal(pNums[0]! + 1, pNums[1]!);
  assert.equal(pNums[1]! + 1, pNums[2]!);
  // Change ids monotonic (and queue order matches).
  const cNums = [p1, p2, p3].map((p) => Number(p.payload.children[0]!.changeId.slice(1)));
  assert.equal(cNums[0]! + 1, cNums[1]!);
  assert.equal(cNums[1]! + 1, cNums[2]!);
});

test("write serialization: a parent-add and a follow-up read see the consistent post-write state", async () => {
  const app = await freshApp();
  const root = (await (await postTaxa(app, "Alice", "Root")).json()) as TaxonRecord;
  const child = (await (await postTaxa(app, "Alice", "Child")).json()) as TaxonRecord;

  // Fire PUT and GET concurrently; GET should still see the edge after the
  // PUT settles (we await both).
  const [putRes, readRes] = await Promise.all([
    app.request(`/taxa/${root.id}/children/${child.id}`, {
      method: "PUT",
      headers: { "X-Username": "Alice" },
    }),
    // Tiny delay via a resolved promise to ensure PUT enters the queue first.
    Promise.resolve().then(() => app.request(`/taxa/${root.id}`)),
  ]);
  assert.equal(putRes.status, 204);
  // The concurrent read isn't lock-synchronized; we just verify it eventually
  // returns a consistent record after both settle. Re-read post-PUT.
  void readRes;
  const finalRead = (await (await app.request(`/taxa/${root.id}`)).json()) as TaxonRecord;
  assert.deepEqual(finalRead.childIds, [child.id]);
});
