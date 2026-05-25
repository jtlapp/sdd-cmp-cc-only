// PRD §6.2 / §15.3 — PATCH /taxa/{id}.
//
// Body: { name?, owner? }. Owner only. Name validation per §3.4 + §3.3
// invariant 3 across every containing tree. Owner reassignment is
// unilateral and requires a registered, non-null target.

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
  caller: string,
  parentId: string,
  childId: string,
): Promise<void> {
  const res = await app.request(`/taxa/${parentId}/children/${childId}`, {
    method: "PUT",
    headers: { "X-Username": caller },
  });
  assert.equal(res.status, 204, `attach ${parentId}→${childId} failed`);
}

async function patchTaxon(
  app: ReturnType<typeof createApp>,
  caller: string | null,
  id: string,
  body: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (caller !== null) headers["X-Username"] = caller;
  return app.request(`/taxa/${id}`, {
    method: "PATCH",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// --- Happy paths -----------------------------------------------------------

test("PATCH /taxa/{id}: owner renames → 200 with updated record", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const t = await postTaxa(app, "Alice", "Fiction");

  const res = await patchTaxon(app, "Alice", t.id, { name: "Speculative Fiction" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as TaxonRecord;
  assert.equal(body.name, "Speculative Fiction");
  assert.equal(body.owner, "Alice");

  const fetched = (await (await app.request(`/taxa/${t.id}`)).json()) as TaxonRecord;
  assert.equal(fetched.name, "Speculative Fiction");
});

test("PATCH /taxa/{id}: owner reassigns to another registered user — recipient may then act, original cannot", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");
  const t = await postTaxa(app, "Alice", "Fiction");

  const res = await patchTaxon(app, "Alice", t.id, { owner: "Bob" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as TaxonRecord;
  assert.equal(body.owner, "Bob");

  // Bob can now PATCH; Alice cannot.
  const bobRename = await patchTaxon(app, "Bob", t.id, { name: "Renamed" });
  assert.equal(bobRename.status, 200);

  const aliceTries = await patchTaxon(app, "Alice", t.id, { name: "Other" });
  assert.equal(aliceTries.status, 403);
});

test("PATCH /taxa/{id}: both name AND owner in one call → both applied atomically", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");
  const t = await postTaxa(app, "Alice", "Fiction");

  const res = await patchTaxon(app, "Alice", t.id, { name: "Renamed", owner: "Bob" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as TaxonRecord;
  assert.equal(body.name, "Renamed");
  assert.equal(body.owner, "Bob");
});

test("PATCH /taxa/{id}: reassigning owner to self → 200 no-op", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const t = await postTaxa(app, "Alice", "Fiction");

  const res = await patchTaxon(app, "Alice", t.id, { owner: "Alice" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as TaxonRecord;
  assert.equal(body.owner, "Alice");
});

test("PATCH /taxa/{id}: setting name to the current value → 200 no-op (validates trivially)", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const t = await postTaxa(app, "Alice", "Fiction");

  const res = await patchTaxon(app, "Alice", t.id, { name: "Fiction" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as TaxonRecord;
  assert.equal(body.name, "Fiction");
});

test("PATCH /taxa/{id}: case-only name change (Fantasy → FANTASY) → 200, casing updates", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const t = await postTaxa(app, "Alice", "Fantasy");

  const res = await patchTaxon(app, "Alice", t.id, { name: "FANTASY" });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as TaxonRecord).name, "FANTASY");
});

// --- Resource / authorization ----------------------------------------------

test("PATCH /taxa/{id}: unknown id → 404", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const res = await patchTaxon(app, "Alice", "tDOESNOTEXIST", { name: "X" });
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as ErrorBody).error.code, "not_found");
});

test("PATCH /taxa/{id}: non-owner caller → 403", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");
  const t = await postTaxa(app, "Alice", "Fiction");

  const res = await patchTaxon(app, "Bob", t.id, { name: "X" });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as ErrorBody).error.code, "forbidden");
});

test("PATCH /taxa/{id}: null user → 403", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const t = await postTaxa(app, "Alice", "Fiction");

  const res = await patchTaxon(app, null, t.id, { name: "X" });
  assert.equal(res.status, 403);
});

test("PATCH /taxa/{id}: unregistered caller → 403", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const t = await postTaxa(app, "Alice", "Fiction");

  const res = await patchTaxon(app, "ghost", t.id, { name: "X" });
  assert.equal(res.status, 403);
});

test("PATCH /taxa/{id}: malformed X-Username (NBSP) → 400", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const t = await postTaxa(app, "Alice", "Fiction");

  const res = await patchTaxon(app, " Alice", t.id, { name: "X" });
  assert.equal(res.status, 400);
});

// --- Body validation -------------------------------------------------------

test("PATCH /taxa/{id}: empty body → 400 (decision #1)", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const t = await postTaxa(app, "Alice", "Fiction");

  const res = await patchTaxon(app, "Alice", t.id, {});
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as ErrorBody).error.code, "validation_error");
});

test("PATCH /taxa/{id}: body without name/owner (only unknown keys) → 400", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const t = await postTaxa(app, "Alice", "Fiction");

  const res = await patchTaxon(app, "Alice", t.id, { foo: 1, bar: "x" });
  assert.equal(res.status, 400);
});

test("PATCH /taxa/{id}: name not a string → 400", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const t = await postTaxa(app, "Alice", "Fiction");

  for (const name of [42, null, true, []]) {
    const res = await patchTaxon(app, "Alice", t.id, { name });
    assert.equal(res.status, 400, `name=${JSON.stringify(name)} should be 400`);
  }
});

test("PATCH /taxa/{id}: malformed name (empty, leading/trailing whitespace) → 400", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const t = await postTaxa(app, "Alice", "Fiction");

  for (const name of ["", " Bad", "Bad ", "\tBad"]) {
    const res = await patchTaxon(app, "Alice", t.id, { name });
    assert.equal(res.status, 400, `name=${JSON.stringify(name)} should be 400`);
  }
});

test("PATCH /taxa/{id}: owner not a string / null / empty / malformed → 400", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const t = await postTaxa(app, "Alice", "Fiction");

  for (const owner of [42, null, true, "", " spaced ", "trailing "]) {
    const res = await patchTaxon(app, "Alice", t.id, { owner });
    assert.equal(res.status, 400, `owner=${JSON.stringify(owner)} should be 400`);
    assert.equal(((await res.json()) as ErrorBody).error.code, "validation_error");
  }
});

test("PATCH /taxa/{id}: owner well-formed but unregistered → 400 (decision #9)", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const t = await postTaxa(app, "Alice", "Fiction");

  const res = await patchTaxon(app, "Alice", t.id, { owner: "Nonexistent" });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as ErrorBody).error.code, "validation_error");
});

test("PATCH /taxa/{id}: unknown keys alongside a valid change are ignored (decision #6)", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const t = await postTaxa(app, "Alice", "Fiction");

  const res = await patchTaxon(app, "Alice", t.id, { name: "Renamed", foo: 1 });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as TaxonRecord).name, "Renamed");
});

// --- Invariant 3 at the HTTP boundary --------------------------------------

test("PATCH /taxa/{id}: rename to a sibling's name in same tree → 409 conflict (name_clash)", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const root = await postTaxa(app, "Alice", "Fiction");
  const a = await postTaxa(app, "Alice", "Fantasy");
  const b = await postTaxa(app, "Alice", "Horror");
  await attach(app, "Alice", root.id, a.id);
  await attach(app, "Alice", root.id, b.id);

  const res = await patchTaxon(app, "Alice", b.id, { name: "Fantasy" });
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "conflict");
  assert.equal(body.error.details?.kind, "name_clash");
});

test("PATCH /taxa/{id}: rename to case-variant of sibling → 409 (case-insensitive per §3.4)", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const root = await postTaxa(app, "Alice", "Fiction");
  const a = await postTaxa(app, "Alice", "Fantasy");
  const b = await postTaxa(app, "Alice", "Horror");
  await attach(app, "Alice", root.id, a.id);
  await attach(app, "Alice", root.id, b.id);

  const res = await patchTaxon(app, "Alice", b.id, { name: "FANTASY" });
  assert.equal(res.status, 409);
});

test("PATCH /taxa/{id}: cross-tree rename — valid in 'own' tree, invalid in another containing tree → 409 (the §3.3 / §14 bullet-5 keystone)", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");

  // Tree R1 (Alice): R1 → X. Tree R2 (Bob): R2 → Foo, R2 → X (X is shared).
  // X is owned by Alice. R1 has no "Foo" sibling. If Alice renames X to
  // "Foo", that's fine in R1 but clashes with R2's "Foo" — must be a 409.
  const r1 = await postTaxa(app, "Alice", "Fiction");
  const r2 = await postTaxa(app, "Bob", "Genre Index");
  const x = await postTaxa(app, "Alice", "X-named");
  const foo = await postTaxa(app, "Bob", "Foo");
  await attach(app, "Alice", r1.id, x.id);
  await attach(app, "Bob", r2.id, x.id);
  await attach(app, "Bob", r2.id, foo.id);

  // Sanity check that x is shared across r1 and r2.
  const r1Tree = (await (await app.request(`/trees/${r1.id}`)).json()) as { children?: { id: string }[] };
  assert.equal(r1Tree.children?.[0]?.id, x.id);

  // Alice renames X to "Foo" — should clash in R2.
  const res = await patchTaxon(app, "Alice", x.id, { name: "Foo" });
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "conflict");
  assert.equal(body.error.details?.kind, "name_clash");
});

test("PATCH /taxa/{id}: rename that doesn't clash anywhere → 200, visible in every containing tree", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");

  const r1 = await postTaxa(app, "Alice", "Fiction");
  const r2 = await postTaxa(app, "Bob", "Genre Index");
  const x = await postTaxa(app, "Alice", "Original");
  await attach(app, "Alice", r1.id, x.id);
  await attach(app, "Bob", r2.id, x.id);

  const res = await patchTaxon(app, "Alice", x.id, { name: "Renamed" });
  assert.equal(res.status, 200);

  // Both trees show the new name.
  const r1Tree = (await (await app.request(`/trees/${r1.id}`)).json()) as { children?: { name?: string }[] };
  const r2Tree = (await (await app.request(`/trees/${r2.id}`)).json()) as { children?: { name?: string }[] };
  assert.equal(r1Tree.children?.[0]?.name, "Renamed");
  assert.equal(r2Tree.children?.[0]?.name, "Renamed");
});

// --- §15.6 envelope smoke for 409 paths ------------------------------------

test("PATCH /taxa/{id}: 409 envelope carries kind + offending root/taxa in details", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const root = await postTaxa(app, "Alice", "Fiction");
  const a = await postTaxa(app, "Alice", "Fantasy");
  const b = await postTaxa(app, "Alice", "Horror");
  await attach(app, "Alice", root.id, a.id);
  await attach(app, "Alice", root.id, b.id);

  const res = await patchTaxon(app, "Alice", b.id, { name: "Fantasy" });
  assert.equal(res.status, 409);
  const body = (await res.json()) as {
    error: { code: string; message: string; details: { kind: string; rootId: string; name: string; taxa: string[] } };
  };
  assert.equal(body.error.code, "conflict");
  assert.equal(body.error.details.kind, "name_clash");
  assert.equal(body.error.details.rootId, root.id);
  assert.equal(body.error.details.name, "fantasy"); // invariant module lowercases
  assert.ok(body.error.details.taxa.includes(a.id) && body.error.details.taxa.includes(b.id));
});
