// End-to-end smoke through createApp: registration + fixture-built graph +
// the four §15.2 reads + reset. Mirrors usersIntegration.test.ts's role for
// Phase 2.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import {
  attachChildFixture,
  createTaxonFixture,
} from "../src/taxa.js";

type TaxonRecord = {
  id: string;
  name: string;
  owner: string;
  childIds: string[];
  parentIds: string[];
};
type TreeNode = { id: string; name?: string; owner?: string; children?: TreeNode[] };
type ErrorBody = { error: { code: string; message: string } };

async function freshApp() {
  const app = createApp();
  await app.request("/reset", { method: "POST" });
  return app;
}

async function register(app: ReturnType<typeof createApp>, username: string) {
  return app.request("/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
}

test("integration: register two users, build a multi-tree graph, exercise all four reads", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");

  // Build a small multi-owner DAG. Owners are referenced by canonical
  // username strings — the store does not check the registry (Phase 4 will
  // close that loop when it adds writes).
  // Tree T1 (root = Fiction):
  //   Fiction (Alice)
  //   └── Fantasy (Alice)
  //       └── Epic Fantasy (Bob)
  // Tree T2 (root = Mystery, with the same Epic Fantasy hanging off it
  // — i.e. Epic Fantasy is shared across T1 and T2):
  //   Mystery (Bob)
  //   └── Epic Fantasy (Bob)            <- shared with T1
  const fiction = createTaxonFixture("Fiction", "Alice");
  const fantasy = createTaxonFixture("Fantasy", "Alice");
  const epicFantasy = createTaxonFixture("Epic Fantasy", "Bob");
  const mystery = createTaxonFixture("Mystery", "Bob");
  attachChildFixture(fiction.id, fantasy.id);
  attachChildFixture(fantasy.id, epicFantasy.id);
  attachChildFixture(mystery.id, epicFantasy.id);

  // --- GET /taxa as Alice
  const taxaAsAlice = await app.request("/taxa", { headers: { "X-Username": "Alice" } });
  assert.equal(taxaAsAlice.status, 200);
  const taxaBody = (await taxaAsAlice.json()) as { taxa: TaxonRecord[] };
  assert.equal(taxaBody.taxa.length, 4);
  const sharedRecord = taxaBody.taxa.find((t) => t.id === epicFantasy.id);
  assert.ok(sharedRecord);
  assert.deepEqual(sharedRecord!.parentIds, [fantasy.id, mystery.id]);

  // --- GET /taxa as the null user
  const taxaAsNull = await app.request("/taxa");
  assert.equal(taxaAsNull.status, 200);

  // --- GET /taxa as an unregistered caller → 403
  const taxaAsGhost = await app.request("/taxa", { headers: { "X-Username": "Carol" } });
  assert.equal(taxaAsGhost.status, 403);
  assert.equal(((await taxaAsGhost.json()) as ErrorBody).error.code, "forbidden");

  // --- GET /trees as Alice
  const treesAsAlice = await app.request("/trees", { headers: { "X-Username": "Alice" } });
  const treesBody = (await treesAsAlice.json()) as { trees: TaxonRecord[] };
  const rootIds = treesBody.trees.map((t) => t.id).sort();
  assert.deepEqual(rootIds, [fiction.id, mystery.id].sort());

  // --- GET /trees/{rootId}
  const t1 = (await (await app.request(`/trees/${fiction.id}`)).json()) as TreeNode;
  assert.equal(t1.children?.[0]?.id, fantasy.id);
  assert.equal(t1.children?.[0]?.children?.[0]?.id, epicFantasy.id);
  const t2 = (await (await app.request(`/trees/${mystery.id}`)).json()) as TreeNode;
  assert.equal(t2.children?.[0]?.id, epicFantasy.id);
});

test("integration: §15.6 envelope codes (400, 403, 404) round-trip through the new routes", async () => {
  const app = await freshApp();
  createTaxonFixture("A", "alice");
  // 400 — malformed X-Username (NBSP-prefixed).
  const bad = await app.request("/taxa", { headers: { "X-Username": " alice" } });
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as ErrorBody).error.code, "validation_error");
  // 403 — well-formed unregistered.
  const forbidden = await app.request("/taxa", { headers: { "X-Username": "ghost" } });
  assert.equal(forbidden.status, 403);
  assert.equal(((await forbidden.json()) as ErrorBody).error.code, "forbidden");
  // 404 — unknown taxon id.
  const nf = await app.request("/taxa/does-not-exist");
  assert.equal(nf.status, 404);
  assert.equal(((await nf.json()) as ErrorBody).error.code, "not_found");
});

test("integration: Phase-1 notFound fallback still applies to unknown route paths", async () => {
  // /taxa/sub/path is not a route; the catch-all 404 in createApp should
  // fire with the §15.6 envelope.
  const app = await freshApp();
  const res = await app.request("/taxa/some/deeper/path");
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as ErrorBody).error.code, "not_found");
});

test("integration: POST /reset wipes BOTH the registry and the taxon store in one call", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const a = createTaxonFixture("A", "Alice");
  attachChildFixture(a.id, createTaxonFixture("B", "Alice").id);

  const reset = await app.request("/reset", { method: "POST" });
  assert.equal(reset.status, 204);

  // Registry empty.
  const users = (await (await app.request("/users")).json()) as { users: string[] };
  assert.deepEqual(users, { users: [] });

  // Taxa empty.
  const taxa = (await (await app.request("/taxa")).json()) as { taxa: TaxonRecord[] };
  assert.deepEqual(taxa, { taxa: [] });

  // Trees empty.
  const trees = (await (await app.request("/trees")).json()) as { trees: TaxonRecord[] };
  assert.deepEqual(trees, { trees: [] });

  // Previously-valid X-Username now 403s.
  const after = await app.request("/taxa", { headers: { "X-Username": "Alice" } });
  assert.equal(after.status, 403);
});
