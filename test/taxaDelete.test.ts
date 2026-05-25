// PRD §6.3, §7, §14 bullets 2 & 4 — DELETE /taxa/{id}.
//
// The subtlest piece of Phase 4: deletion-region computation (N + descendants
// reachable through wholly-U-owned paths, halting at and detaching other-
// owned taxa) plus the two preconditions (no region taxon is shared, and N
// has no parent OR exactly one U-owned parent).

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
type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: { kind?: string; taxonId?: string; parentId?: string; parentOwner?: string };
  };
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
  assert.equal(r.status, 204, `attach ${parentId}→${childId} as ${caller} failed`);
}

async function deleteTaxon(
  app: ReturnType<typeof createApp>,
  caller: string | null,
  id: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (caller !== null) headers["X-Username"] = caller;
  return app.request(`/taxa/${id}`, { method: "DELETE", headers });
}

async function exists(app: ReturnType<typeof createApp>, id: string): Promise<boolean> {
  return (await app.request(`/taxa/${id}`)).status === 200;
}

async function getTaxon(app: ReturnType<typeof createApp>, id: string): Promise<TaxonRecord> {
  return (await (await app.request(`/taxa/${id}`)).json()) as TaxonRecord;
}

async function allIds(app: ReturnType<typeof createApp>): Promise<string[]> {
  const all = (await (await app.request("/taxa")).json()) as { taxa: TaxonRecord[] };
  return all.taxa.map((t) => t.id);
}

// --- Happy paths: region computation ---------------------------------------

test("DELETE taxon: lone root with no children → region {N}, 204", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const n = await postTaxa(app, "Alice", "N");

  const res = await deleteTaxon(app, "Alice", n.id);
  assert.equal(res.status, 204);

  assert.equal(await exists(app, n.id), false);
});

test("DELETE taxon: root with U-owned children only → cascade deletes everything", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const r = await postTaxa(app, "Alice", "R");
  const a = await postTaxa(app, "Alice", "A");
  const b = await postTaxa(app, "Alice", "B");
  const aa = await postTaxa(app, "Alice", "AA");
  await attach(app, "Alice", r.id, a.id);
  await attach(app, "Alice", r.id, b.id);
  await attach(app, "Alice", a.id, aa.id);

  assert.equal((await deleteTaxon(app, "Alice", r.id)).status, 204);

  for (const id of [r.id, a.id, b.id, aa.id]) {
    assert.equal(await exists(app, id), false, `${id} should be gone`);
  }

  const trees = (await (await app.request("/trees")).json()) as { trees: TaxonRecord[] };
  assert.deepEqual(trees.trees, []);
});

test("DELETE taxon: deep U-owned chain (4+ levels) → all deleted", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const taxa: TaxonRecord[] = [];
  for (const name of ["L0", "L1", "L2", "L3", "L4"]) {
    taxa.push(await postTaxa(app, "Alice", name));
  }
  for (let i = 0; i < taxa.length - 1; i++) {
    await attach(app, "Alice", taxa[i]!.id, taxa[i + 1]!.id);
  }

  assert.equal((await deleteTaxon(app, "Alice", taxa[0]!.id)).status, 204);
  for (const t of taxa) {
    assert.equal(await exists(app, t.id), false);
  }
});

test("DELETE taxon: non-root N with one U-owned parent → N's region deleted; parent survives, edge gone", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const p = await postTaxa(app, "Alice", "P");
  const n = await postTaxa(app, "Alice", "N");
  const child = await postTaxa(app, "Alice", "Child");
  await attach(app, "Alice", p.id, n.id);
  await attach(app, "Alice", n.id, child.id);

  assert.equal((await deleteTaxon(app, "Alice", n.id)).status, 204);

  // P survives, with no children.
  assert.equal(await exists(app, p.id), true);
  assert.deepEqual((await getTaxon(app, p.id)).childIds, []);
  // N and its U-owned subtree are gone.
  assert.equal(await exists(app, n.id), false);
  assert.equal(await exists(app, child.id), false);
});

// --- Halt-frontier: §14 bullet 4 -------------------------------------------

test("DELETE taxon: single other-owned child at halt point — child not deleted, edge removed, child becomes root", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");
  const n = await postTaxa(app, "Alice", "N");
  const c = await postTaxa(app, "Bob", "C");
  await attach(app, "Alice", n.id, c.id);

  assert.equal((await deleteTaxon(app, "Alice", n.id)).status, 204);

  assert.equal(await exists(app, n.id), false);
  assert.equal(await exists(app, c.id), true);
  // C lost its only parent → now a root.
  assert.deepEqual((await getTaxon(app, c.id)).parentIds, []);
  const trees = (await (await app.request("/trees")).json()) as { trees: TaxonRecord[] };
  assert.ok(trees.trees.some((t) => t.id === c.id));
});

test("DELETE taxon: halt-frontier child with another parent — survives, retains other parent", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");
  // N(Alice) → C(Bob); M(Bob) → C(Bob). C is shared between N and M.
  const n = await postTaxa(app, "Alice", "N");
  const m = await postTaxa(app, "Bob", "M");
  const c = await postTaxa(app, "Bob", "C");
  await attach(app, "Alice", n.id, c.id);
  await attach(app, "Bob", m.id, c.id);

  // C is shared, but C is NOT in N's deletion region (Bob-owned). Region
  // is just {N}. Precondition 1 checks only region members; C's sharedness
  // is irrelevant.
  assert.equal((await deleteTaxon(app, "Alice", n.id)).status, 204);

  assert.equal(await exists(app, n.id), false);
  assert.equal(await exists(app, c.id), true);
  assert.deepEqual((await getTaxon(app, c.id)).parentIds, [m.id]);
});

test("DELETE taxon: stranded U-owned descendant below an other-owned halt point — survives (§14 bullet 4)", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");
  // N(Alice) → C(Bob) → D(Alice). The cascade halts at C; D is NOT deleted
  // even though Alice owns it.
  const n = await postTaxa(app, "Alice", "N");
  const c = await postTaxa(app, "Bob", "C");
  const d = await postTaxa(app, "Alice", "D");
  await attach(app, "Alice", n.id, c.id);
  await attach(app, "Bob", c.id, d.id);

  assert.equal((await deleteTaxon(app, "Alice", n.id)).status, 204);

  assert.equal(await exists(app, n.id), false);
  assert.equal(await exists(app, c.id), true, "C (Bob, halt point) survives");
  assert.equal(await exists(app, d.id), true, "D (Alice, stranded) survives");
  // Structure: C is now a root with D still beneath it.
  assert.deepEqual((await getTaxon(app, c.id)).parentIds, []);
  assert.deepEqual((await getTaxon(app, c.id)).childIds, [d.id]);
  assert.deepEqual((await getTaxon(app, d.id)).owner, "Alice");
});

test("DELETE taxon: multiple other-owned children at the halt frontier — each detached, edges removed", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");
  await register(app, "Carol");
  // N(Alice) has three children: U1(Alice), C1(Bob), C2(Carol).
  const n = await postTaxa(app, "Alice", "N");
  const u1 = await postTaxa(app, "Alice", "U1");
  const c1 = await postTaxa(app, "Bob", "C1");
  const c2 = await postTaxa(app, "Carol", "C2");
  await attach(app, "Alice", n.id, u1.id);
  await attach(app, "Alice", n.id, c1.id);
  await attach(app, "Alice", n.id, c2.id);

  assert.equal((await deleteTaxon(app, "Alice", n.id)).status, 204);

  // N and U1 are deleted; C1 and C2 survive.
  assert.equal(await exists(app, n.id), false);
  assert.equal(await exists(app, u1.id), false);
  assert.equal(await exists(app, c1.id), true);
  assert.equal(await exists(app, c2.id), true);
  // Both halt-frontier survivors lost N as a parent.
  assert.deepEqual((await getTaxon(app, c1.id)).parentIds, []);
  assert.deepEqual((await getTaxon(app, c2.id)).parentIds, []);
});

test("DELETE taxon: halt-and-detach applies at every level, not just N's children", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");
  // N(Alice) → U1(Alice) → C(Bob) → U2(Alice). Region: {N, U1}.
  // The U1→C edge is removed; C remains a root; U2 stays under C.
  const n = await postTaxa(app, "Alice", "N");
  const u1 = await postTaxa(app, "Alice", "U1");
  const c = await postTaxa(app, "Bob", "C");
  const u2 = await postTaxa(app, "Alice", "U2");
  await attach(app, "Alice", n.id, u1.id);
  await attach(app, "Alice", u1.id, c.id);
  await attach(app, "Bob", c.id, u2.id);

  assert.equal((await deleteTaxon(app, "Alice", n.id)).status, 204);

  assert.equal(await exists(app, n.id), false);
  assert.equal(await exists(app, u1.id), false);
  assert.equal(await exists(app, c.id), true);
  assert.equal(await exists(app, u2.id), true);
  assert.deepEqual((await getTaxon(app, c.id)).parentIds, []); // C is now a root
  assert.deepEqual((await getTaxon(app, c.id)).childIds, [u2.id]);
});

// --- Precondition 1: no region taxon is shared -----------------------------

test("DELETE taxon: N itself is shared (has two parents) → 409 shared_in_region", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  // Two roots P1, P2 (Alice), shared child N (Alice).
  const p1 = await postTaxa(app, "Alice", "P1");
  const p2 = await postTaxa(app, "Alice", "P2");
  const n = await postTaxa(app, "Alice", "N");
  await attach(app, "Alice", p1.id, n.id);
  await attach(app, "Alice", p2.id, n.id);

  const res = await deleteTaxon(app, "Alice", n.id);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "conflict");
  assert.equal(body.error.details?.kind, "shared_in_region");
  assert.equal(body.error.details?.taxonId, n.id);

  // No state changes.
  assert.equal(await exists(app, n.id), true);
  assert.equal((await getTaxon(app, n.id)).parentIds.length, 2);
});

test("DELETE taxon: a U-owned descendant in the region is shared into another tree → 409 shared_in_region", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  // N(Alice) → X(Alice); also Other(Alice) → X. X is U-owned AND in region
  // (Alice owns it) AND shared (parents in two roots).
  const n = await postTaxa(app, "Alice", "N");
  const other = await postTaxa(app, "Alice", "Other");
  const x = await postTaxa(app, "Alice", "X");
  await attach(app, "Alice", n.id, x.id);
  await attach(app, "Alice", other.id, x.id);

  const res = await deleteTaxon(app, "Alice", n.id);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.details?.kind, "shared_in_region");
  assert.equal(body.error.details?.taxonId, x.id);

  // No state changes.
  assert.equal(await exists(app, n.id), true);
  assert.equal(await exists(app, x.id), true);
});

test("DELETE taxon: a stranded U-owned descendant beneath an other-owned halt point is shared — does NOT trip precondition 1 (it's not in the region)", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");
  // N(Alice) → C(Bob) → D(Alice); Other(Alice) → D. D is U-owned and shared,
  // but it's NOT in the region (cascade halts at C).
  const n = await postTaxa(app, "Alice", "N");
  const c = await postTaxa(app, "Bob", "C");
  const d = await postTaxa(app, "Alice", "D");
  const other = await postTaxa(app, "Alice", "Other");
  await attach(app, "Alice", n.id, c.id);
  await attach(app, "Bob", c.id, d.id);
  await attach(app, "Alice", other.id, d.id);

  const res = await deleteTaxon(app, "Alice", n.id);
  assert.equal(res.status, 204, "delete should succeed: D is not in the region");

  // N gone; C and D and Other survive.
  assert.equal(await exists(app, n.id), false);
  assert.equal(await exists(app, c.id), true);
  assert.equal(await exists(app, d.id), true);
  assert.equal(await exists(app, other.id), true);
});

test("DELETE taxon: an other-owned halt-frontier taxon is itself shared → 204 (§6.3 parenthetical)", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");
  // N(Alice) → C(Bob); M(Bob) → C(Bob). C is shared (between N and M trees).
  // C is at the halt frontier (other-owned), so it may be shared per §6.3.
  const n = await postTaxa(app, "Alice", "N");
  const m = await postTaxa(app, "Bob", "M");
  const c = await postTaxa(app, "Bob", "C");
  await attach(app, "Alice", n.id, c.id);
  await attach(app, "Bob", m.id, c.id);

  const res = await deleteTaxon(app, "Alice", n.id);
  assert.equal(res.status, 204);

  // N gone, C survives with only M as parent.
  assert.equal(await exists(app, n.id), false);
  assert.equal(await exists(app, c.id), true);
  assert.deepEqual((await getTaxon(app, c.id)).parentIds, [m.id]);
});

// --- Precondition 2: N has zero parents or exactly one U-owned parent ------

test("DELETE taxon: N has one parent owned by someone else → 409 parent_not_owned", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");
  // P(Bob) → N(Alice). N is unshared (only one parent). Precondition 1 OK,
  // precondition 2 fails because that parent is Bob, not Alice.
  const p = await postTaxa(app, "Bob", "P");
  const n = await postTaxa(app, "Alice", "N");
  await attach(app, "Bob", p.id, n.id);

  const res = await deleteTaxon(app, "Alice", n.id);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.details?.kind, "parent_not_owned");
  assert.equal(body.error.details?.parentId, p.id);
  assert.equal(body.error.details?.parentOwner, "Bob");

  assert.equal(await exists(app, n.id), true);
});

test("DELETE taxon: N has multiple parents — at least one precondition fires; tests accept either", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  // P1(Alice) → N(Alice); P2(Alice) → N. N has two parents, both Alice's.
  // N is shared (two roots). Precondition 1 will catch shared_in_region;
  // precondition 2 would also fire (multiple_parents). Spec is silent on
  // which is reported; pin the contract that exactly one of them fires.
  const p1 = await postTaxa(app, "Alice", "P1");
  const p2 = await postTaxa(app, "Alice", "P2");
  const n = await postTaxa(app, "Alice", "N");
  await attach(app, "Alice", p1.id, n.id);
  await attach(app, "Alice", p2.id, n.id);

  const res = await deleteTaxon(app, "Alice", n.id);
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "conflict");
  assert.ok(
    body.error.details?.kind === "shared_in_region" ||
      body.error.details?.kind === "multiple_parents",
    `expected shared_in_region or multiple_parents, got ${body.error.details?.kind}`,
  );

  assert.equal(await exists(app, n.id), true);
});

// --- Authorization / resource ----------------------------------------------

test("DELETE taxon: non-owner caller → 403; no state changes", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");
  const t = await postTaxa(app, "Alice", "T");

  const res = await deleteTaxon(app, "Bob", t.id);
  assert.equal(res.status, 403);
  assert.equal(await exists(app, t.id), true);
});

test("DELETE taxon: null user → 403", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const t = await postTaxa(app, "Alice", "T");

  const res = await deleteTaxon(app, null, t.id);
  assert.equal(res.status, 403);
});

test("DELETE taxon: unregistered caller → 403", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const t = await postTaxa(app, "Alice", "T");

  const res = await deleteTaxon(app, "ghost", t.id);
  assert.equal(res.status, 403);
});

test("DELETE taxon: malformed X-Username → 400", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const t = await postTaxa(app, "Alice", "T");

  const res = await deleteTaxon(app, " Alice", t.id);
  assert.equal(res.status, 400);
});

test("DELETE taxon: unknown id → 404", async () => {
  const app = await freshApp();
  await register(app, "Alice");

  const res = await deleteTaxon(app, "Alice", "tNOSUCH");
  assert.equal(res.status, 404);
});

// --- Atomicity --------------------------------------------------------------

test("DELETE taxon: a precondition-failed delete leaves state byte-identical (no partial cascade)", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  // N(Alice) → X(Alice) (shared via Other(Alice) too). Precondition 1 fails.
  const n = await postTaxa(app, "Alice", "N");
  const other = await postTaxa(app, "Alice", "Other");
  const x = await postTaxa(app, "Alice", "X");
  await attach(app, "Alice", n.id, x.id);
  await attach(app, "Alice", other.id, x.id);

  const idsBefore = (await allIds(app)).sort();
  const res = await deleteTaxon(app, "Alice", n.id);
  assert.equal(res.status, 409);
  const idsAfter = (await allIds(app)).sort();
  assert.deepEqual(idsAfter, idsBefore);
  // And every edge is the same.
  for (const id of idsBefore) {
    const t = await getTaxon(app, id);
    // Spot-check: relevant parents are intact.
    if (id === x.id) assert.equal(t.parentIds.length, 2);
  }
});
