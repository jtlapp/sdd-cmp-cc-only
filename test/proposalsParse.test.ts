// PRD §9.1, §9.2, §15.4, §15.6 — proposal payload parsing & body validation.
//
// Pure body-level concerns: the proposal envelope, per-op schema, top-taxon
// constraints, and the §4 identity gate composing with POST /proposals.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  attach,
  createTaxon,
  ErrorBody,
  freshApp,
  postProposal,
  register,
} from "./proposalsTestHelpers.js";

// --- A small fixture --------------------------------------------------------
//
// Builds a two-tree multi-owner state via Phase-4 writes:
//   r1 (Alice)
//   └── c1 (Alice)
//   r2 (Bob)
// Returns the freshly-allocated ids so the test can address them.
async function fixtureMulti() {
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "Speculative Fiction")).id;
  await attach(app, "alice", r1, c1);
  const r2 = (await createTaxon(app, "bob", "Genre Index")).id;
  return { app, r1, c1, r2 };
}

// --- Body envelope ----------------------------------------------------------

test("POST /proposals: minimal valid no-op top → 201", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1 },
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { id: string; payload: { op: string; id: string; disposition: string } };
  assert.match(body.id, /^p\d+$/);
  assert.equal(body.payload.op, "no-op");
  assert.equal(body.payload.id, r1);
  assert.equal(body.payload.disposition, "structural");
});

test("POST /proposals: invalid JSON body → 400", async () => {
  const { app } = await fixtureMulti();
  const res = await app.request("/proposals", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Username": "alice",
    },
    body: "not json",
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "validation_error");
});

for (const v of [42, "string", true, null, [1, 2]] as const) {
  test(`POST /proposals: non-object body (${JSON.stringify(v)}) → 400`, async () => {
    const { app } = await fixtureMulti();
    const res = await postProposal(app, "alice", v);
    assert.equal(res.status, 400);
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.error.code, "validation_error");
  });
}

for (const omit of ["targetRootId", "topTaxonId", "payload"] as const) {
  test(`POST /proposals: missing ${omit} → 400`, async () => {
    const { app, r1 } = await fixtureMulti();
    const body: Record<string, unknown> = {
      targetRootId: r1,
      topTaxonId: r1,
      payload: { op: "no-op", id: r1 },
    };
    delete body[omit];
    const res = await postProposal(app, "alice", body);
    assert.equal(res.status, 400);
    const json = (await res.json()) as ErrorBody;
    assert.equal(json.error.code, "validation_error");
  });
}

test("POST /proposals: targetRootId not a string → 400", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: 123,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1 },
  });
  assert.equal(res.status, 400);
});

test("POST /proposals: topTaxonId not a string → 400", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: null,
    payload: { op: "no-op", id: r1 },
  });
  assert.equal(res.status, 400);
});

test("POST /proposals: payload not a JSON object → 400", async () => {
  const { app, r1 } = await fixtureMulti();
  for (const bad of [[1, 2], "x", null] as const) {
    const res = await postProposal(app, "alice", {
      targetRootId: r1,
      topTaxonId: r1,
      payload: bad,
    });
    assert.equal(res.status, 400, `payload=${JSON.stringify(bad)}`);
  }
});

test("POST /proposals: unknown top-level keys ignored (decision #14)", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1 },
    extra: "ignored",
  });
  assert.equal(res.status, 201);
});

// --- Per-op schema ----------------------------------------------------------

test("POST /proposals: each op accepted in a valid position", async () => {
  // Builds a structure rich enough that every op can be exercised at least
  // once in this single proposal.
  // r1 (Alice)
  // ├── c1 (Alice)
  // │   └── c1a (Alice)   ← to be detached
  // └── c2 (Alice)         ← will be renamed
  // r1 is the anchor (no-op at top).
  const app = await freshApp();
  await register(app, "alice");
  await register(app, "bob");
  await register(app, "carol");
  const r1 = (await createTaxon(app, "alice", "Fiction")).id;
  const c1 = (await createTaxon(app, "alice", "A")).id;
  const c1a = (await createTaxon(app, "alice", "AA")).id;
  const c2 = (await createTaxon(app, "alice", "B")).id;
  const graftable = (await createTaxon(app, "bob", "GraftMe")).id;
  await attach(app, "alice", r1, c1);
  await attach(app, "alice", c1, c1a);
  await attach(app, "alice", r1, c2);

  const res = await postProposal(app, "carol", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        {
          op: "no-op",
          id: c1,
          children: [{ op: "detach", id: c1a }],
        },
        { op: "rename", id: c2, name: "Renamed B" },
        { op: "add", id: null, name: "New Child" },
        { op: "add", id: graftable },
      ],
    },
  });
  assert.equal(res.status, 201, await res.text());
});

for (const badOp of ["foo", null, 1, undefined] as const) {
  test(`POST /proposals: invalid op ${JSON.stringify(badOp)} → 400`, async () => {
    const { app, r1 } = await fixtureMulti();
    const child: Record<string, unknown> = { id: r1 };
    if (badOp !== undefined) child.op = badOp;
    const res = await postProposal(app, "alice", {
      targetRootId: r1,
      topTaxonId: r1,
      payload: { op: "no-op", id: r1, children: [child] },
    });
    assert.equal(res.status, 400);
  });
}

test("POST /proposals: no-op without id → 400", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1, children: [{ op: "no-op" }] },
  });
  assert.equal(res.status, 400);
});

test("POST /proposals: no-op with non-string id → 400", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1, children: [{ op: "no-op", id: 12 }] },
  });
  assert.equal(res.status, 400);
});

test("POST /proposals: rename without id → 400", async () => {
  const { app, r1, c1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", name: "X" }],
    },
  });
  void c1;
  assert.equal(res.status, 400);
});

test("POST /proposals: rename without name → 400", async () => {
  const { app, r1, c1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: c1 }],
    },
  });
  assert.equal(res.status, 400);
});

for (const bad of ["", " leading", "trailing "] as const) {
  test(`POST /proposals: rename with bad name ${JSON.stringify(bad)} → 400`, async () => {
    const { app, r1, c1 } = await fixtureMulti();
    const res = await postProposal(app, "alice", {
      targetRootId: r1,
      topTaxonId: r1,
      payload: {
        op: "no-op",
        id: r1,
        children: [{ op: "rename", id: c1, name: bad }],
      },
    });
    assert.equal(res.status, 400);
  });
}

test("POST /proposals: add without id key → 400 (missing key is not null)", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", name: "X" }],
    },
  });
  assert.equal(res.status, 400);
});

test("POST /proposals: add (create) requires name → 400 without it", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", id: null }],
    },
  });
  assert.equal(res.status, 400);
});

test("POST /proposals: add (create) with bad-format name → 400", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", id: null, name: " leading" }],
    },
  });
  assert.equal(res.status, 400);
});

test("POST /proposals: add with non-null non-string id → 400", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", id: 42 }],
    },
  });
  assert.equal(res.status, 400);
});

test("POST /proposals: detach with children → 400 (leaf rule)", async () => {
  const { app, r1, c1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [
        {
          op: "detach",
          id: c1,
          children: [{ op: "no-op", id: c1 }],
        },
      ],
    },
  });
  assert.equal(res.status, 400);
});

test("POST /proposals: detach without id → 400", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1, children: [{ op: "detach" }] },
  });
  assert.equal(res.status, 400);
});

test("POST /proposals: children not an array → 400", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1, children: { not: "array" } },
  });
  assert.equal(res.status, 400);
});

test("POST /proposals: child entry not an object → 400", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1, children: ["not an object"] },
  });
  assert.equal(res.status, 400);
});

test("POST /proposals: unknown extra keys on a payload node are ignored", async () => {
  const { app, r1, c1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      extra: 42,
      children: [{ op: "no-op", id: c1, bonus: "ignored" }],
    },
  });
  assert.equal(res.status, 201);
});

// --- Top-taxon constraints (§9.2) ------------------------------------------

test("POST /proposals: top op = add → 400", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "add", id: null, name: "X" },
  });
  assert.equal(res.status, 400);
});

test("POST /proposals: top op = detach → 400", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "detach", id: r1 },
  });
  assert.equal(res.status, 400);
});

test("POST /proposals: payload.id mismatches topTaxonId → 400 (decision #2)", async () => {
  const { app, r1, c1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: c1 },
  });
  assert.equal(res.status, 400);
});

test("POST /proposals: topTaxonId names unknown taxon → 404", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: "t-does-not-exist",
    payload: { op: "no-op", id: "t-does-not-exist" },
  });
  assert.equal(res.status, 404);
});

test("POST /proposals: top taxon exists but not in target tree → 409", async () => {
  // r1 (Alice) is one tree; r2 (Bob) is another. Target r1, anchor at r2.
  const { app, r1, r2 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r2,
    payload: { op: "no-op", id: r2 },
  });
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "conflict");
  assert.equal(body.error.details?.kind, "top_not_in_tree");
});

// --- targetRootId validation (decision #5) ---------------------------------

test("POST /proposals: targetRootId unknown → 404", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: "t-bogus",
    topTaxonId: r1,
    payload: { op: "no-op", id: r1 },
  });
  assert.equal(res.status, 404);
});

test("POST /proposals: targetRootId is not a root (has parents) → 409", async () => {
  const { app, r1, c1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: c1,
    topTaxonId: c1,
    payload: { op: "no-op", id: c1 },
  });
  assert.equal(res.status, 409);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.details?.kind, "not_a_root");
  void r1;
});

// --- Submission-time existence (decision #3) -------------------------------

test("POST /proposals: nested rename with unknown id → 404", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "rename", id: "t-missing", name: "X" }],
    },
  });
  assert.equal(res.status, 404);
});

test("POST /proposals: nested detach with unknown id → 404", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "detach", id: "t-missing" }],
    },
  });
  assert.equal(res.status, 404);
});

test("POST /proposals: nested graft with unknown id → 404", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "add", id: "t-missing" }],
    },
  });
  assert.equal(res.status, 404);
});

test("POST /proposals: nested no-op with unknown id → 404", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "alice", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: {
      op: "no-op",
      id: r1,
      children: [{ op: "no-op", id: "t-missing" }],
    },
  });
  assert.equal(res.status, 404);
});

// --- Authorization (mirrors Phase 4) ---------------------------------------

test("POST /proposals: null user → 403", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, null, {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1 },
  });
  assert.equal(res.status, 403);
});

test("POST /proposals: unregistered well-formed caller → 403", async () => {
  const { app, r1 } = await fixtureMulti();
  const res = await postProposal(app, "zelda", {
    targetRootId: r1,
    topTaxonId: r1,
    payload: { op: "no-op", id: r1 },
  });
  assert.equal(res.status, 403);
});

test("POST /proposals: malformed X-Username (NBSP) → 400", async () => {
  const { app, r1 } = await fixtureMulti();
  // U+00A0 NBSP survives Hono's header normalization (Phase-2 / Phase-4 note).
  const res = await app.request("/proposals", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Username": " alice",
    },
    body: JSON.stringify({
      targetRootId: r1,
      topTaxonId: r1,
      payload: { op: "no-op", id: r1 },
    }),
  });
  assert.equal(res.status, 400);
});
