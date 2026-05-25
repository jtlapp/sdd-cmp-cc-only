// PRD §6.1 / §15.3 — POST /taxa.
//
// Body: { name }. Caller (registered, non-null) becomes the owner; the
// taxon is created as a root with no children.

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
type ErrorBody = { error: { code: string; message: string; details?: unknown } };

async function freshApp() {
  const app = createApp();
  await app.request("/reset", { method: "POST" });
  return app;
}

async function register(app: ReturnType<typeof createApp>, username: string) {
  const res = await app.request("/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  assert.equal(res.status, 201, `registering ${username} failed`);
}

async function postTaxa(
  app: ReturnType<typeof createApp>,
  caller: string | null,
  body: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (caller !== null) headers["X-Username"] = caller;
  return app.request("/taxa", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// --- Happy paths -----------------------------------------------------------

test("POST /taxa: registered caller creates a root taxon owned by themselves", async () => {
  const app = await freshApp();
  await register(app, "Alice");

  const res = await postTaxa(app, "Alice", { name: "Fiction" });
  assert.equal(res.status, 201);
  const body = (await res.json()) as TaxonRecord;
  assert.equal(body.name, "Fiction");
  assert.equal(body.owner, "Alice");
  assert.deepEqual(body.childIds, []);
  assert.deepEqual(body.parentIds, []);
  assert.match(body.id, /^t\d+$/);
});

test("POST /taxa: consecutive creates issue distinct monotonic IDs", async () => {
  const app = await freshApp();
  await register(app, "Alice");

  const a = (await (await postTaxa(app, "Alice", { name: "A" })).json()) as TaxonRecord;
  const b = (await (await postTaxa(app, "Alice", { name: "B" })).json()) as TaxonRecord;
  const c = (await (await postTaxa(app, "Alice", { name: "C" })).json()) as TaxonRecord;
  assert.notEqual(a.id, b.id);
  assert.notEqual(b.id, c.id);
  // Lexicographic order of t1, t2, t3 — relies on the implementation's
  // monotonic counter; tests don't assume specific values.
  const nums = [a, b, c].map((r) => Number(r.id.slice(1)));
  assert.deepEqual(
    nums.slice().sort((x, y) => x - y),
    nums,
  );
});

test("POST /taxa: freshly created taxon appears in reads as a root", async () => {
  const app = await freshApp();
  await register(app, "Alice");

  const created = (await (await postTaxa(app, "Alice", { name: "Fiction" })).json()) as TaxonRecord;

  // GET /taxa lists it.
  const allTaxa = (await (await app.request("/taxa")).json()) as { taxa: TaxonRecord[] };
  assert.equal(allTaxa.taxa.length, 1);
  assert.equal(allTaxa.taxa[0]!.id, created.id);

  // GET /trees lists it as a root.
  const allTrees = (await (await app.request("/trees")).json()) as { trees: TaxonRecord[] };
  assert.equal(allTrees.trees.length, 1);
  assert.equal(allTrees.trees[0]!.id, created.id);

  // GET /trees/{id} returns the recursive shape.
  const tree = (await (await app.request(`/trees/${created.id}`)).json()) as {
    id: string;
    name?: string;
    owner?: string;
    children?: unknown[];
  };
  assert.equal(tree.id, created.id);
  assert.equal(tree.name, "Fiction");
  assert.equal(tree.owner, "Alice");
  assert.deepEqual(tree.children, []);
});

test("POST /taxa: two registered users each create their own taxa, owners distinct", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");

  const aliceT = (await (await postTaxa(app, "Alice", { name: "Fiction" })).json()) as TaxonRecord;
  const bobT = (await (await postTaxa(app, "Bob", { name: "Nonfiction" })).json()) as TaxonRecord;
  assert.equal(aliceT.owner, "Alice");
  assert.equal(bobT.owner, "Bob");

  const allTaxa = (await (await app.request("/taxa")).json()) as { taxa: TaxonRecord[] };
  assert.equal(allTaxa.taxa.length, 2);
});

// --- Authorization ---------------------------------------------------------

test("POST /taxa: null user (no X-Username) → 403 forbidden", async () => {
  const app = await freshApp();
  const res = await postTaxa(app, null, { name: "Fiction" });
  assert.equal(res.status, 403);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "forbidden");
});

test("POST /taxa: unregistered well-formed caller → 403 forbidden", async () => {
  const app = await freshApp();
  const res = await postTaxa(app, "ghost", { name: "Fiction" });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as ErrorBody).error.code, "forbidden");
});

test("POST /taxa: malformed X-Username (NBSP-prefixed) → 400 validation_error", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const res = await postTaxa(app, " Alice", { name: "Fiction" });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as ErrorBody).error.code, "validation_error");
});

// --- Body validation -------------------------------------------------------

test("POST /taxa: invalid JSON → 400", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const res = await postTaxa(app, "Alice", "{not json");
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as ErrorBody).error.code, "validation_error");
});

test("POST /taxa: non-object body → 400", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  for (const body of [[], "string", 42, null]) {
    const res = await postTaxa(app, "Alice", body);
    assert.equal(res.status, 400, `body ${JSON.stringify(body)} should be 400`);
  }
});

test("POST /taxa: missing 'name' field → 400", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  const res = await postTaxa(app, "Alice", {});
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as ErrorBody).error.code, "validation_error");
});

test("POST /taxa: 'name' not a string → 400", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  for (const name of [42, null, true, [], {}]) {
    const res = await postTaxa(app, "Alice", { name });
    assert.equal(res.status, 400, `name=${JSON.stringify(name)} should be 400`);
  }
});

test("POST /taxa: name format violations → 400 (empty, leading/trailing whitespace)", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  for (const name of ["", " Fiction", "Fiction ", "\tFiction", "Fiction\n"]) {
    const res = await postTaxa(app, "Alice", { name });
    assert.equal(res.status, 400, `name=${JSON.stringify(name)} should be 400`);
    assert.equal(
      ((await res.json()) as ErrorBody).error.code,
      "validation_error",
    );
  }
});

test("POST /taxa: unknown body keys (including 'owner') are ignored — caller is owner per §6.1", async () => {
  const app = await freshApp();
  await register(app, "Alice");
  await register(app, "Bob");

  const res = await postTaxa(app, "Alice", { name: "Fiction", owner: "Bob", foo: 1 });
  assert.equal(res.status, 201);
  const body = (await res.json()) as TaxonRecord;
  assert.equal(body.owner, "Alice", "creator is owner regardless of body.owner");
});
