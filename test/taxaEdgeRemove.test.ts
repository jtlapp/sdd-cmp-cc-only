// PRD §6.4, §7 — DELETE /taxa/{parentId}/children/{childId}.
//
// Pure detach. Never delete (§7). No invariant checks (removing an edge
// cannot create a cycle, duplicate, or name clash). Missing edge → 404
// (decision #3).

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
type ErrorBody = { error: { code: string; message: string } };

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

async function detach(
  app: ReturnType<typeof createApp>,
  caller: string | null,
  parentId: string,
  childId: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (caller !== null) headers["X-Username"] = caller;
  return app.request(`/taxa/${parentId}/children/${childId}`, {
    method: "DELETE",
    headers,
  });
}

async function getTaxon(app: ReturnType<typeof createApp>, id: string): Promise<TaxonRecord> {
  return (await (await app.request(`/taxa/${id}`)).json()) as TaxonRecord;
}

// --- Happy paths -----------------------------------------------------------

test("DELETE edge: parent owner detaches a single-parent child → 204; child becomes a root", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const p = await postTaxa(app, "Alice", "Fiction");
  const c = await postTaxa(app, "Alice", "Fantasy");
  await attach(app, "Alice", p.id, c.id);

  const res = await detach(app, "Alice", p.id, c.id);
  assert.equal(res.status, 204);

  const pBack = await getTaxon(app, p.id);
  const cBack = await getTaxon(app, c.id);
  assert.deepEqual(pBack.childIds, []);
  assert.deepEqual(cBack.parentIds, []);

  const trees = (await (await app.request("/trees")).json()) as { trees: TaxonRecord[] };
  assert.ok(trees.trees.some((t) => t.id === c.id), "detached child should be a root");
});

test("DELETE edge: detaching a shared child → 204; child retains other parents", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");
  const r1 = await postTaxa(app, "Alice", "R1");
  const r2 = await postTaxa(app, "Bob", "R2");
  const x = await postTaxa(app, "Alice", "X");
  await attach(app, "Alice", r1.id, x.id);
  await attach(app, "Bob", r2.id, x.id);

  // Bob detaches X from R2; X must still be under R1.
  const res = await detach(app, "Bob", r2.id, x.id);
  assert.equal(res.status, 204);

  const xBack = await getTaxon(app, x.id);
  assert.deepEqual(xBack.parentIds, [r1.id]);
});

test("DELETE edge: detach preserves the child's subtree (§7 detach ≠ delete)", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const root = await postTaxa(app, "Alice", "Root");
  const middle = await postTaxa(app, "Alice", "Middle");
  const leaf = await postTaxa(app, "Alice", "Leaf");
  await attach(app, "Alice", root.id, middle.id);
  await attach(app, "Alice", middle.id, leaf.id);

  // Detach root→middle. Middle and its leaf must still exist.
  assert.equal((await detach(app, "Alice", root.id, middle.id)).status, 204);

  // Middle now a root with leaf still under it.
  const allTaxa = (await (await app.request("/taxa")).json()) as { taxa: TaxonRecord[] };
  const ids = allTaxa.taxa.map((t) => t.id);
  assert.ok(ids.includes(middle.id));
  assert.ok(ids.includes(leaf.id));

  const middleBack = await getTaxon(app, middle.id);
  assert.deepEqual(middleBack.childIds, [leaf.id]);
});

// --- Resource / authorization ----------------------------------------------

test("DELETE edge: unknown parent → 404", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const c = await postTaxa(app, "Alice", "C");
  const res = await detach(app, "Alice", "tNOSUCH", c.id);
  assert.equal(res.status, 404);
});

test("DELETE edge: unknown child → 404", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const p = await postTaxa(app, "Alice", "P");
  const res = await detach(app, "Alice", p.id, "tNOSUCH");
  assert.equal(res.status, 404);
});

test("DELETE edge: both exist but no edge between them → 404 (decision #3)", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const p = await postTaxa(app, "Alice", "P");
  const c = await postTaxa(app, "Alice", "C");
  // Never attached.
  const res = await detach(app, "Alice", p.id, c.id);
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as ErrorBody).error.code, "not_found");
});

test("DELETE edge: non-parent-owner → 403", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");
  const p = await postTaxa(app, "Alice", "P");
  const c = await postTaxa(app, "Bob", "C");
  await attach(app, "Alice", p.id, c.id);

  // Bob owns the child but not the parent — only parent's owner can detach.
  const res = await detach(app, "Bob", p.id, c.id);
  assert.equal(res.status, 403);
});

test("DELETE edge: null user → 403", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const p = await postTaxa(app, "Alice", "P");
  const c = await postTaxa(app, "Alice", "C");
  await attach(app, "Alice", p.id, c.id);

  const res = await detach(app, null, p.id, c.id);
  assert.equal(res.status, 403);
});

test("DELETE edge: unregistered caller → 403", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const p = await postTaxa(app, "Alice", "P");
  const c = await postTaxa(app, "Alice", "C");
  await attach(app, "Alice", p.id, c.id);

  const res = await detach(app, "ghost", p.id, c.id);
  assert.equal(res.status, 403);
});

test("DELETE edge: malformed X-Username → 400", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const p = await postTaxa(app, "Alice", "P");
  const c = await postTaxa(app, "Alice", "C");
  await attach(app, "Alice", p.id, c.id);

  const res = await detach(app, " Alice", p.id, c.id);
  assert.equal(res.status, 400);
});

test("DELETE edge: post-detach the child is still in /taxa (detach is not delete)", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const p = await postTaxa(app, "Alice", "P");
  const c = await postTaxa(app, "Alice", "C");
  await attach(app, "Alice", p.id, c.id);

  assert.equal((await detach(app, "Alice", p.id, c.id)).status, 204);

  const allTaxa = (await (await app.request("/taxa")).json()) as { taxa: TaxonRecord[] };
  assert.equal(allTaxa.taxa.length, 2, "both parent and child still exist");
});
