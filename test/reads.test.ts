// PRD §15.2 — GET /taxa, GET /taxa/{id}, GET /trees, GET /trees/{rootId}.
//
// End-to-end through createApp. Per the toolchain supplement, each test
// resets first then seeds the specific shape via the fixture primitives.

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
type ErrorBody = { error: { code: string; message: string } };
type TreeNode = { id: string; name?: string; owner?: string; children?: TreeNode[] };

async function freshApp() {
  const app = createApp();
  // Register a user so we can hit reads as a registered caller too.
  await app.request("/reset", { method: "POST" });
  return app;
}

async function registerAlice(app: ReturnType<typeof createApp>) {
  await app.request("/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "Alice" }),
  });
}

// --- GET /taxa -------------------------------------------------------------

test("GET /taxa: empty store → 200 with empty list", async () => {
  const app = await freshApp();
  const res = await app.request("/taxa");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { taxa: [] });
});

test("GET /taxa: returns taxa in creation order with the full record shape", async () => {
  const app = await freshApp();
  const a = createTaxonFixture("Fiction", "alice");
  const b = createTaxonFixture("Fantasy", "alice");
  attachChildFixture(a.id, b.id);
  const res = await app.request("/taxa");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { taxa: TaxonRecord[] };
  assert.equal(body.taxa.length, 2);
  assert.deepEqual(body.taxa[0], {
    id: a.id, name: "Fiction", owner: "alice",
    childIds: [b.id], parentIds: [],
  });
  assert.deepEqual(body.taxa[1], {
    id: b.id, name: "Fantasy", owner: "alice",
    childIds: [], parentIds: [a.id],
  });
});

// --- GET /taxa/{id} --------------------------------------------------------

test("GET /taxa/{id}: existing taxon → 200 with full record", async () => {
  const app = await freshApp();
  const a = createTaxonFixture("Fiction", "alice");
  const res = await app.request(`/taxa/${a.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    id: a.id, name: "Fiction", owner: "alice",
    childIds: [], parentIds: [],
  });
});

test("GET /taxa/{id}: missing id → 404 with not_found envelope", async () => {
  const app = await freshApp();
  const res = await app.request("/taxa/nope");
  assert.equal(res.status, 404);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "not_found");
  assert.match(body.error.message, /nope/);
});

test("GET /taxa/{id}: a shared taxon lists both parents in attachment order", async () => {
  const app = await freshApp();
  const r1 = createTaxonFixture("R1", "alice");
  const r2 = createTaxonFixture("R2", "alice");
  const s = createTaxonFixture("Shared", "alice");
  attachChildFixture(r1.id, s.id);
  attachChildFixture(r2.id, s.id);
  const res = await app.request(`/taxa/${s.id}`);
  const body = (await res.json()) as TaxonRecord;
  assert.deepEqual(body.parentIds, [r1.id, r2.id]);
});

// --- GET /trees ------------------------------------------------------------

test("GET /trees: empty store → 200 with empty list", async () => {
  const app = await freshApp();
  const res = await app.request("/trees");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { trees: [] });
});

test("GET /trees: two roots with chains under each — both appear with parentIds: []", async () => {
  const app = await freshApp();
  const r1 = createTaxonFixture("R1", "alice");
  const a = createTaxonFixture("A", "alice");
  attachChildFixture(r1.id, a.id);
  const r2 = createTaxonFixture("R2", "alice");
  const b = createTaxonFixture("B", "alice");
  attachChildFixture(r2.id, b.id);
  const res = await app.request("/trees");
  const body = (await res.json()) as { trees: TaxonRecord[] };
  assert.equal(body.trees.length, 2);
  const ids = body.trees.map((t) => t.id).sort();
  assert.deepEqual(ids, [r1.id, r2.id].sort());
  for (const root of body.trees) {
    assert.deepEqual(root.parentIds, []);
  }
});

test("GET /trees: a previously-root taxon attached under another parent no longer appears", async () => {
  const app = await freshApp();
  const r1 = createTaxonFixture("R1", "alice");
  const formerRoot = createTaxonFixture("FormerRoot", "alice");
  attachChildFixture(r1.id, formerRoot.id);
  const res = await app.request("/trees");
  const body = (await res.json()) as { trees: TaxonRecord[] };
  const ids = body.trees.map((t) => t.id);
  assert.deepEqual(ids, [r1.id]);
});

// --- GET /trees/{rootId} ---------------------------------------------------

test("GET /trees/{rootId}: a leaf root → { id, name, owner, children: [] }", async () => {
  const app = await freshApp();
  const r = createTaxonFixture("Fiction", "alice");
  const res = await app.request(`/trees/${r.id}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as TreeNode;
  assert.deepEqual(body, {
    id: r.id, name: "Fiction", owner: "alice", children: [],
  });
});

test("GET /trees/{rootId}: two-children root expands them in insertion order", async () => {
  const app = await freshApp();
  const r = createTaxonFixture("Fiction", "alice");
  const a = createTaxonFixture("Fantasy", "alice");
  const b = createTaxonFixture("Thriller", "alice");
  attachChildFixture(r.id, a.id);
  attachChildFixture(r.id, b.id);
  const res = await app.request(`/trees/${r.id}`);
  const body = (await res.json()) as TreeNode;
  assert.equal(body.id, r.id);
  assert.equal(body.children?.length, 2);
  assert.equal(body.children?.[0]?.id, a.id);
  assert.equal(body.children?.[1]?.id, b.id);
});

test("GET /trees/{rootId}: deeper subtree expanded fully", async () => {
  const app = await freshApp();
  const r = createTaxonFixture("Fiction", "alice");
  const f = createTaxonFixture("Fantasy", "alice");
  const e = createTaxonFixture("Epic Fantasy", "alice");
  attachChildFixture(r.id, f.id);
  attachChildFixture(f.id, e.id);
  const res = await app.request(`/trees/${r.id}`);
  const body = (await res.json()) as TreeNode;
  assert.equal(body.children?.[0]?.id, f.id);
  assert.equal(body.children?.[0]?.children?.[0]?.id, e.id);
  assert.equal(body.children?.[0]?.children?.[0]?.children?.length, 0);
});

test("GET /trees/{rootId}: a shared child appears under both roots when each tree is fetched", async () => {
  const app = await freshApp();
  const r1 = createTaxonFixture("R1", "alice");
  const r2 = createTaxonFixture("R2", "alice");
  const s = createTaxonFixture("Shared", "alice");
  attachChildFixture(r1.id, s.id);
  attachChildFixture(r2.id, s.id);
  const t1 = (await (await app.request(`/trees/${r1.id}`)).json()) as TreeNode;
  const t2 = (await (await app.request(`/trees/${r2.id}`)).json()) as TreeNode;
  assert.equal(t1.children?.[0]?.id, s.id);
  assert.equal(t2.children?.[0]?.id, s.id);
});

test("GET /trees/{id}: non-root existing id → 404 with 'not a root' message", async () => {
  const app = await freshApp();
  const r = createTaxonFixture("R", "alice");
  const child = createTaxonFixture("Child", "alice");
  attachChildFixture(r.id, child.id);
  const res = await app.request(`/trees/${child.id}`);
  assert.equal(res.status, 404);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "not_found");
  assert.match(body.error.message, /not a root/);
});

test("GET /trees/{id}: missing id → 404 not_found", async () => {
  const app = await freshApp();
  const res = await app.request("/trees/nope");
  assert.equal(res.status, 404);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "not_found");
});

test("GET /trees/{rootId}: fixture-induced in-tree diamond finitizes (decision #1)", async () => {
  // Production Phase-4 writes will refuse to create this graph; in Phase 3
  // we can build it with the fixture primitives. The response must remain
  // finite — the duplicated taxon is expanded only at its first visit; the
  // second occurrence is a bare { id } stub.
  const app = await freshApp();
  const r = createTaxonFixture("R", "alice");
  const a = createTaxonFixture("A", "alice");
  const b = createTaxonFixture("B", "alice");
  const x = createTaxonFixture("X", "alice");
  attachChildFixture(r.id, a.id);
  attachChildFixture(r.id, b.id);
  attachChildFixture(a.id, x.id);
  attachChildFixture(b.id, x.id);

  const res = await app.request(`/trees/${r.id}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as TreeNode;
  // Under a: X is fully expanded.
  const underA = body.children?.find((c) => c.id === a.id);
  const underB = body.children?.find((c) => c.id === b.id);
  const xUnderA = underA?.children?.[0];
  const xUnderB = underB?.children?.[0];
  assert.equal(xUnderA?.id, x.id);
  assert.equal(xUnderB?.id, x.id);
  // Exactly one of them has the full record shape; the other is a stub.
  const fullExpansions = [xUnderA, xUnderB].filter((n) => n?.name !== undefined).length;
  assert.equal(fullExpansions, 1, "exactly one of the two X occurrences is fully expanded");
  const stubs = [xUnderA, xUnderB].filter((n) => n?.name === undefined).length;
  assert.equal(stubs, 1, "the other X occurrence is a stub");
});

// --- identity gate (interaction with Phase 2 middleware) -------------------

test("reads: all four endpoints accept the null user (no X-Username)", async () => {
  const app = await freshApp();
  const r = createTaxonFixture("R", "alice");
  for (const path of ["/taxa", `/taxa/${r.id}`, "/trees", `/trees/${r.id}`]) {
    const res = await app.request(path);
    assert.equal(res.status, 200, `null user should read ${path}`);
  }
});

test("reads: all four endpoints accept a registered caller", async () => {
  const app = await freshApp();
  await registerAlice(app);
  const r = createTaxonFixture("R", "alice");
  for (const path of ["/taxa", `/taxa/${r.id}`, "/trees", `/trees/${r.id}`]) {
    const res = await app.request(path, { headers: { "X-Username": "Alice" } });
    assert.equal(res.status, 200, `Alice should read ${path}`);
  }
});

test("reads: all four endpoints 403 on an unregistered non-null caller", async () => {
  const app = await freshApp();
  const r = createTaxonFixture("R", "alice");
  for (const path of ["/taxa", `/taxa/${r.id}`, "/trees", `/trees/${r.id}`]) {
    const res = await app.request(path, { headers: { "X-Username": "ghost" } });
    assert.equal(res.status, 403, `ghost should be forbidden on ${path}`);
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.error.code, "forbidden");
  }
});

test("reads: all four endpoints 400 on malformed X-Username (NBSP-prefixed)", async () => {
  // Per Phase 2 final-plan note: NBSP survives HTTP OWS stripping while
  // still matching JS \s, so it's the canonical "malformed" header input.
  const app = await freshApp();
  const r = createTaxonFixture("R", "alice");
  for (const path of ["/taxa", `/taxa/${r.id}`, "/trees", `/trees/${r.id}`]) {
    const res = await app.request(path, { headers: { "X-Username": " alice" } });
    assert.equal(res.status, 400, `malformed header should 400 on ${path}`);
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.error.code, "validation_error");
  }
});

// --- reset extends to taxa --------------------------------------------------

test("reset: clearing wipes taxa AND resets the ID counter to t1", async () => {
  const app = await freshApp();
  const a = createTaxonFixture("A", "alice");
  const b = createTaxonFixture("B", "alice");
  attachChildFixture(a.id, b.id);
  // Sanity
  let listing = (await (await app.request("/taxa")).json()) as { taxa: TaxonRecord[] };
  assert.equal(listing.taxa.length, 2);

  const reset = await app.request("/reset", { method: "POST" });
  assert.equal(reset.status, 204);

  listing = (await (await app.request("/taxa")).json()) as { taxa: TaxonRecord[] };
  assert.deepEqual(listing, { taxa: [] });

  // The next allocation reuses t1.
  const fresh = createTaxonFixture("Fresh", "alice");
  assert.equal(fresh.id, "t1");
});

test("reset: previously-issued taxon ids 404 on /taxa/{id} and /trees/{id}", async () => {
  const app = await freshApp();
  const a = createTaxonFixture("A", "alice");
  const id = a.id;
  await app.request("/reset", { method: "POST" });
  const r1 = await app.request(`/taxa/${id}`);
  assert.equal(r1.status, 404);
  const r2 = await app.request(`/trees/${id}`);
  assert.equal(r2.status, 404);
});

test("reset: trees endpoint after reset returns empty", async () => {
  const app = await freshApp();
  createTaxonFixture("A", "alice");
  await app.request("/reset", { method: "POST" });
  const res = await app.request("/trees");
  assert.deepEqual(await res.json(), { trees: [] });
});
