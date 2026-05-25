// Phase 4 integration suite — multi-step stories exercising the full write
// surface together with the Phase-2 identity gate and the Phase-3 reads.

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
  return app;
}

async function register(app: ReturnType<typeof createApp>, username: string) {
  const r = await app.request("/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  assert.equal(r.status, 201);
}

async function postTaxa(
  app: ReturnType<typeof createApp>,
  caller: string,
  name: string,
): Promise<TaxonRecord> {
  const res = await app.request("/taxa", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Username": caller },
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as TaxonRecord;
}

async function attach(
  app: ReturnType<typeof createApp>,
  caller: string,
  parentId: string,
  childId: string,
): Promise<void> {
  const r = await app.request(`/taxa/${parentId}/children/${childId}`, {
    method: "PUT",
    headers: { "X-Username": caller },
  });
  assert.equal(r.status, 204);
}

async function getTaxon(app: ReturnType<typeof createApp>, id: string): Promise<TaxonRecord> {
  return (await (await app.request(`/taxa/${id}`)).json()) as TaxonRecord;
}

test("integration: multi-owner story — create, transfer ownership, recipient acts, original blocked", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");

  // Alice builds a small tree.
  const root = await postTaxa(app, "Alice", "Fiction");
  const fantasy = await postTaxa(app, "Alice", "Fantasy");
  await attach(app, "Alice", root.id, fantasy.id);

  // Alice reassigns Fantasy to Bob (unilateral, §6.2).
  const transfer = await app.request(`/taxa/${fantasy.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Username": "Alice" },
    body: JSON.stringify({ owner: "Bob" }),
  });
  assert.equal(transfer.status, 200);

  // Bob can now rename it.
  const bobRename = await app.request(`/taxa/${fantasy.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Username": "Bob" },
    body: JSON.stringify({ name: "Speculative" }),
  });
  assert.equal(bobRename.status, 200);

  // Alice can't.
  const aliceRetry = await app.request(`/taxa/${fantasy.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Username": "Alice" },
    body: JSON.stringify({ name: "Other" }),
  });
  assert.equal(aliceRetry.status, 403);

  // Reads see the new name + owner.
  const fetched = await getTaxon(app, fantasy.id);
  assert.equal(fetched.name, "Speculative");
  assert.equal(fetched.owner, "Bob");
});

test("integration: §14 bullet 4 stranded U-owned demonstration end-to-end", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");
  // N(Alice) → C(Bob) → D(Alice). Alice deletes N. Result: N gone; C
  // becomes a root with D beneath it; D still owned by Alice.
  const n = await postTaxa(app, "Alice", "N");
  const c = await postTaxa(app, "Bob", "C");
  const d = await postTaxa(app, "Alice", "D");
  await attach(app, "Alice", n.id, c.id);
  await attach(app, "Bob", c.id, d.id);

  const del = await app.request(`/taxa/${n.id}`, {
    method: "DELETE",
    headers: { "X-Username": "Alice" },
  });
  assert.equal(del.status, 204);

  const taxa = (await (await app.request("/taxa")).json()) as { taxa: TaxonRecord[] };
  const ids = taxa.taxa.map((t) => t.id);
  assert.ok(!ids.includes(n.id));
  assert.ok(ids.includes(c.id));
  assert.ok(ids.includes(d.id));

  const trees = (await (await app.request("/trees")).json()) as { trees: TaxonRecord[] };
  assert.ok(trees.trees.some((t) => t.id === c.id), "C is now a root");

  const dRecord = await getTaxon(app, d.id);
  assert.equal(dRecord.owner, "Alice");
});

test("integration: cross-tree rename — succeeds when no clash, 409s when target name conflicts in another tree", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");

  // Build two trees that share X (owned by Alice). R2 has a sibling "Foo".
  const r1 = await postTaxa(app, "Alice", "R1");
  const r2 = await postTaxa(app, "Bob", "R2");
  const x = await postTaxa(app, "Alice", "X");
  const foo = await postTaxa(app, "Bob", "Foo");
  await attach(app, "Alice", r1.id, x.id);
  await attach(app, "Bob", r2.id, x.id);
  await attach(app, "Bob", r2.id, foo.id);

  // Rename to a safe value first → 200, both trees see it.
  const safe = await app.request(`/taxa/${x.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Username": "Alice" },
    body: JSON.stringify({ name: "Renamed" }),
  });
  assert.equal(safe.status, 200);

  // Now rename to a clashing value → 409.
  const clash = await app.request(`/taxa/${x.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Username": "Alice" },
    body: JSON.stringify({ name: "Foo" }),
  });
  assert.equal(clash.status, 409);

  // Post-failure name is the previous safe value, not the attempted clash.
  assert.equal((await getTaxon(app, x.id)).name, "Renamed");
});

test("integration: reset between flows wipes everything, ID counter restarts", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await postTaxa(app, "Alice", "Fiction");

  await app.request("/reset", { method: "POST" });

  // Registry empty.
  const users = (await (await app.request("/users")).json()) as { users: string[] };
  assert.deepEqual(users.users, []);
  // Taxa empty.
  const taxa = (await (await app.request("/taxa")).json()) as { taxa: TaxonRecord[] };
  assert.deepEqual(taxa.taxa, []);

  // Re-register and create → ID counter restarted.
  await register(app, "Alice");
  const fresh = await postTaxa(app, "Alice", "Fresh");
  assert.equal(fresh.id, "t1");
});

test("integration: a delete blocked by precondition fails 409, then Alice fixes the shape and the retry succeeds", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  // Build N(Alice) → X(Alice); Other(Alice) → X. X is shared. Alice's
  // delete of N fails precondition 1. She detaches the Other→X edge (she
  // owns Other), and retries.
  const n = await postTaxa(app, "Alice", "N");
  const other = await postTaxa(app, "Alice", "Other");
  const x = await postTaxa(app, "Alice", "X");
  await attach(app, "Alice", n.id, x.id);
  await attach(app, "Alice", other.id, x.id);

  const first = await app.request(`/taxa/${n.id}`, {
    method: "DELETE",
    headers: { "X-Username": "Alice" },
  });
  assert.equal(first.status, 409);

  // Detach Other→X so X is no longer shared.
  const detach = await app.request(`/taxa/${other.id}/children/${x.id}`, {
    method: "DELETE",
    headers: { "X-Username": "Alice" },
  });
  assert.equal(detach.status, 204);

  // Retry succeeds.
  const retry = await app.request(`/taxa/${n.id}`, {
    method: "DELETE",
    headers: { "X-Username": "Alice" },
  });
  assert.equal(retry.status, 204);

  // Final state: N gone, X gone (cascaded), Other survives.
  const taxa = (await (await app.request("/taxa")).json()) as { taxa: TaxonRecord[] };
  const ids = taxa.taxa.map((t) => t.id);
  assert.ok(!ids.includes(n.id));
  assert.ok(!ids.includes(x.id));
  assert.ok(ids.includes(other.id));
});
