// PRD §6.4 — PUT /taxa/{parentId}/children/{childId}.
//
// Parent owner only. Validates against §3.3 invariants in affected tree(s)
// via the Phase-3 invariant module. Idempotent re-add (decision #2).

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
type ErrorBody = { error: { code: string; message: string; details?: { kind?: string } } };

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
  assert.equal(res.status, 201, `create ${name} failed`);
  return (await res.json()) as TaxonRecord;
}

async function attach(
  app: ReturnType<typeof createApp>,
  caller: string | null,
  parentId: string,
  childId: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (caller !== null) headers["X-Username"] = caller;
  return app.request(`/taxa/${parentId}/children/${childId}`, {
    method: "PUT",
    headers,
  });
}

async function getTaxon(app: ReturnType<typeof createApp>, id: string): Promise<TaxonRecord> {
  return (await (await app.request(`/taxa/${id}`)).json()) as TaxonRecord;
}

// --- Happy paths -----------------------------------------------------------

test("PUT edge: parent owner adds a previously-disconnected child → 204; edge present on both ends", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const parent = await postTaxa(app, "Alice", "Fiction");
  const child = await postTaxa(app, "Alice", "Fantasy");

  const res = await attach(app, "Alice", parent.id, child.id);
  assert.equal(res.status, 204);

  const p = await getTaxon(app, parent.id);
  const c = await getTaxon(app, child.id);
  assert.deepEqual(p.childIds, [child.id]);
  assert.deepEqual(c.parentIds, [parent.id]);
});

test("PUT edge: re-adding an existing edge → 204 idempotent, no duplicate entries", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const parent = await postTaxa(app, "Alice", "Fiction");
  const child = await postTaxa(app, "Alice", "Fantasy");

  assert.equal((await attach(app, "Alice", parent.id, child.id)).status, 204);
  assert.equal((await attach(app, "Alice", parent.id, child.id)).status, 204);

  const p = await getTaxon(app, parent.id);
  const c = await getTaxon(app, child.id);
  assert.deepEqual(p.childIds, [child.id]); // not [c.id, c.id]
  assert.deepEqual(c.parentIds, [parent.id]);
});

test("PUT edge: child attached under two different trees → both trees show it; child is shared", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");
  const r1 = await postTaxa(app, "Alice", "Fiction");
  const r2 = await postTaxa(app, "Bob", "Genre Index");
  const c = await postTaxa(app, "Alice", "Fantasy");

  assert.equal((await attach(app, "Alice", r1.id, c.id)).status, 204);
  assert.equal((await attach(app, "Bob", r2.id, c.id)).status, 204);

  const child = await getTaxon(app, c.id);
  assert.equal(child.parentIds.length, 2);
  assert.ok(child.parentIds.includes(r1.id));
  assert.ok(child.parentIds.includes(r2.id));
});

// --- Resource / authorization ----------------------------------------------

test("PUT edge: unknown parent → 404", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const c = await postTaxa(app, "Alice", "Fantasy");
  const res = await attach(app, "Alice", "tNOSUCH", c.id);
  assert.equal(res.status, 404);
});

test("PUT edge: unknown child → 404", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const p = await postTaxa(app, "Alice", "Fiction");
  const res = await attach(app, "Alice", p.id, "tNOSUCH");
  assert.equal(res.status, 404);
});

test("PUT edge: non-parent-owner caller (even child-owner) → 403", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");
  const parent = await postTaxa(app, "Alice", "Fiction");
  const child = await postTaxa(app, "Bob", "Fantasy");

  // Bob owns child but not parent — must be parent's owner.
  const res = await attach(app, "Bob", parent.id, child.id);
  assert.equal(res.status, 403);
});

test("PUT edge: null user → 403", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const p = await postTaxa(app, "Alice", "Fiction");
  const c = await postTaxa(app, "Alice", "Fantasy");
  const res = await attach(app, null, p.id, c.id);
  assert.equal(res.status, 403);
});

test("PUT edge: malformed X-Username → 400", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const p = await postTaxa(app, "Alice", "Fiction");
  const c = await postTaxa(app, "Alice", "Fantasy");
  const res = await attach(app, " Alice", p.id, c.id);
  assert.equal(res.status, 400);
});

// --- Invariant violations (409) --------------------------------------------

test("PUT edge: self-loop X→X → 409 cycle", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const x = await postTaxa(app, "Alice", "X");

  const res = await attach(app, "Alice", x.id, x.id);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "conflict");
  assert.equal(body.error.details?.kind, "cycle");
});

test("PUT edge: deeper cycle (attach ancestor under descendant) → 409 cycle", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const a = await postTaxa(app, "Alice", "A");
  const b = await postTaxa(app, "Alice", "B");
  const c = await postTaxa(app, "Alice", "C");
  await attach(app, "Alice", a.id, b.id);
  await attach(app, "Alice", b.id, c.id);

  // Adding C → A makes A a descendant of A.
  const res = await attach(app, "Alice", c.id, a.id);
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as ErrorBody).error.details?.kind, "cycle");

  // State must be unchanged after the rejected add.
  const cBack = await getTaxon(app, c.id);
  assert.deepEqual(cBack.childIds, []);
});

test("PUT edge: in-tree diamond (child reachable from same root twice) → 409 in_tree_duplicate", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  // R → A → X already; PUT R/children/X would make X reachable from R via
  // R→X directly AND via R→A→X.
  const r = await postTaxa(app, "Alice", "R");
  const a = await postTaxa(app, "Alice", "A");
  const x = await postTaxa(app, "Alice", "X");
  await attach(app, "Alice", r.id, a.id);
  await attach(app, "Alice", a.id, x.id);

  const res = await attach(app, "Alice", r.id, x.id);
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as ErrorBody).error.details?.kind, "in_tree_duplicate");

  // State unchanged — r still has only [a].
  const rBack = await getTaxon(app, r.id);
  assert.deepEqual(rBack.childIds, [a.id]);
});

test("PUT edge: in-tree name clash → 409 name_clash", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const r = await postTaxa(app, "Alice", "R");
  const f1 = await postTaxa(app, "Alice", "Fantasy");
  const f2 = await postTaxa(app, "Alice", "Fantasy"); // global names aren't unique
  await attach(app, "Alice", r.id, f1.id);

  // Adding f2 under r would put two "Fantasy" siblings in tree r.
  const res = await attach(app, "Alice", r.id, f2.id);
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as ErrorBody).error.details?.kind, "name_clash");

  // State unchanged.
  const rBack = await getTaxon(app, r.id);
  assert.deepEqual(rBack.childIds, [f1.id]);
});

test("PUT edge: grafting a subtree whose internal name clashes with the receiving tree → 409", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  // Receiving tree: R → Fantasy
  const r = await postTaxa(app, "Alice", "R");
  const f1 = await postTaxa(app, "Alice", "Fantasy");
  await attach(app, "Alice", r.id, f1.id);
  // Graft candidate: G with child Fantasy (a different taxon with same name).
  const g = await postTaxa(app, "Alice", "G");
  const f2 = await postTaxa(app, "Alice", "Fantasy");
  await attach(app, "Alice", g.id, f2.id);

  // Attaching G under R brings F2 (named "Fantasy") into R's tree alongside F1.
  const res = await attach(app, "Alice", r.id, g.id);
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as ErrorBody).error.details?.kind, "name_clash");
});

test("PUT edge: same name allowed under two different trees", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");

  // Tree R1 has child "Fantasy" (f1); tree R2 wants its own "Fantasy" (f2).
  const r1 = await postTaxa(app, "Alice", "R1");
  const r2 = await postTaxa(app, "Bob", "R2");
  const f1 = await postTaxa(app, "Alice", "Fantasy");
  const f2 = await postTaxa(app, "Bob", "Fantasy");
  assert.equal((await attach(app, "Alice", r1.id, f1.id)).status, 204);

  // Different taxon named "Fantasy" in a different tree — allowed.
  assert.equal((await attach(app, "Bob", r2.id, f2.id)).status, 204);
});

test("PUT edge: invariant rejection leaves state byte-identical (no partial edge)", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const r = await postTaxa(app, "Alice", "R");
  const f1 = await postTaxa(app, "Alice", "Fantasy");
  const f2 = await postTaxa(app, "Alice", "Fantasy");
  await attach(app, "Alice", r.id, f1.id);

  const before = (await (await app.request("/taxa")).json()) as { taxa: TaxonRecord[] };
  const res = await attach(app, "Alice", r.id, f2.id);
  assert.equal(res.status, 409);
  const after = (await (await app.request("/taxa")).json()) as { taxa: TaxonRecord[] };
  assert.deepEqual(after, before);
});
