// Domain read endpoints from PRD §15.2.
//
//   GET /taxa             — list all taxa
//   GET /taxa/{id}        — retrieve a single taxon
//   GET /trees            — list all roots, each identifying a tree
//   GET /trees/{rootId}   — retrieve the full tree expanded from a root
//
// All four are behind identityWithRegistry: null users may read (§15.2),
// well-formed-but-unregistered → 403, malformed X-Username → 400. The
// envelope helpers from src/errors.ts surface §15.6 responses.
//
// Response shapes (resolved up front in test-plans/phase-3-initial.md):
//   - Each taxon is { id, name, owner, childIds, parentIds } (decision #2).
//     childIds are in attachment order; parentIds in the order each parent
//     acquired this child (decision #4).
//   - GET /taxa → { taxa: [<record>...] } in creation order.
//   - GET /trees → { trees: [<record>...] }; roots have parentIds: [].
//   - GET /trees/{rootId} → recursive { id, name, owner, children: [...] }
//     where children are full sub-objects (decision #1). On a graph that
//     deliberately violates invariant 2 (no Phase-4 write path can produce
//     this in production — fixtures only in Phase 3), the recursive
//     expansion finitizes by expanding each taxon at most once per
//     response: a taxon revisited along a second in-tree path appears as a
//     bare { id } stub under its second parent, with no `children` field,
//     so the response remains finite.
//   - 404 not_found for an unknown id; for /trees/{id} where id names a
//     non-root taxon, 404 with a message distinguishing "not a root" from
//     "no such taxon" (decision #3).

import { Hono } from "hono";

import { ApiError } from "../errors.js";
import type { AppEnv } from "../identity.js";
import { identityWithRegistry } from "../middleware/identity.js";
import {
  allTaxa,
  getState,
  getTaxon,
  parentsOfTaxon,
} from "../taxa.js";
import type { Taxon, TaxonId } from "../taxa.js";

export const readsRouter = new Hono<AppEnv>();

// All four endpoints share the same identity gate.
readsRouter.use("/taxa", identityWithRegistry);
readsRouter.use("/taxa/*", identityWithRegistry);
readsRouter.use("/trees", identityWithRegistry);
readsRouter.use("/trees/*", identityWithRegistry);

interface TaxonRecord {
  id: TaxonId;
  name: string;
  owner: string;
  childIds: TaxonId[];
  parentIds: TaxonId[];
}

function recordOf(t: Taxon): TaxonRecord {
  return {
    id: t.id,
    name: t.name,
    owner: t.owner,
    childIds: Array.from(t.childIds),
    parentIds: parentsOfTaxon(t.id),
  };
}

// --- GET /taxa -------------------------------------------------------------

readsRouter.get("/taxa", (c) => {
  const taxa = allTaxa().map(recordOf);
  return c.json({ taxa });
});

// --- GET /taxa/{id} --------------------------------------------------------

readsRouter.get("/taxa/:id", (c) => {
  const id = c.req.param("id");
  const t = getTaxon(id);
  if (t === undefined) {
    throw new ApiError("not_found", `no such taxon: ${id}`);
  }
  return c.json(recordOf(t));
});

// --- GET /trees ------------------------------------------------------------
//
// Each entry is the root taxon's full record (so parentIds is always []).

readsRouter.get("/trees", (c) => {
  const state = getState();
  const trees: TaxonRecord[] = [];
  for (const t of state.taxa.values()) {
    const parents = state.parentsOf.get(t.id);
    if (parents === undefined || parents.size === 0) {
      trees.push(recordOf(t));
    }
  }
  return c.json({ trees });
});

// --- GET /trees/{rootId} ---------------------------------------------------
//
// Recursive expansion. A revisited taxon (only possible on a fixture-induced
// invariant-2 violation; impossible under Phase-4 writes) collapses to a
// bare { id } stub on its second appearance to keep the response finite.
// Cycle-safety: the same first-visit-only rule terminates loops.

interface TreeNode {
  id: TaxonId;
  name?: string;
  owner?: string;
  children?: TreeNode[];
}

readsRouter.get("/trees/:rootId", (c) => {
  const rootId = c.req.param("rootId");
  const t = getTaxon(rootId);
  if (t === undefined) {
    throw new ApiError("not_found", `no such taxon: ${rootId}`);
  }
  const parents = getState().parentsOf.get(rootId);
  if (parents !== undefined && parents.size > 0) {
    throw new ApiError(
      "not_found",
      `taxon ${rootId} is not a root (it has parents); /trees/{rootId} requires a root id`,
    );
  }

  const seen = new Set<TaxonId>();
  function expand(id: TaxonId): TreeNode {
    if (seen.has(id)) {
      // Revisit — collapse to a stub to finitize the response.
      return { id };
    }
    seen.add(id);
    const node = getTaxon(id);
    // node will always be defined here: we never enqueue an unknown id
    // (only existing children get walked), and the root was checked above.
    if (node === undefined) return { id };
    return {
      id: node.id,
      name: node.name,
      owner: node.owner,
      children: Array.from(node.childIds).map(expand),
    };
  }

  return c.json(expand(rootId));
});
