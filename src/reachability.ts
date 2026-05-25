// Reachability layer from PRD §3.2 and §3.3.
//
// Pure functions over a TaxonState snapshot — no I/O, no mutation. Callers
// pass in the state explicitly so the same functions are reusable by:
//   - the invariant module (src/invariants.ts), which reasons about an
//     arbitrary candidate state,
//   - the read routes (src/routes/reads.ts), which mirror live state,
//   - Phase 4+ write paths, which will materialize "live + change" and
//     re-evaluate.
//
// Terminology, restated from §3.2:
//   - root: a taxon with no parents.
//   - tree: the structure reachable downward from a root; identified by
//     the root's id.
//   - subtree: the structure reachable downward from any taxon (a tree is
//     a subtree whose top taxon is a root).
//   - A taxon may appear in more than one tree — the global structure is
//     a DAG, not a forest.

import type { TaxonId, TaxonState } from "./taxa.js";

/**
 * All roots of the global graph in taxon-creation order. A root is a taxon
 * with no parents.
 */
export function roots(state: TaxonState): TaxonId[] {
  const out: TaxonId[] = [];
  for (const t of state.taxa.values()) {
    const parents = state.parentsOf.get(t.id);
    if (parents === undefined || parents.size === 0) {
      out.push(t.id);
    }
  }
  return out;
}

/**
 * Strict downward closure from `taxonId` (NOT including `taxonId` itself).
 * Robust against cycles in fixture-built graphs: each id is visited at
 * most once.
 *
 * Returns ids in the order they are first discovered by a breadth-first
 * walk from the starting taxon's children outward.
 */
export function descendants(taxonId: TaxonId, state: TaxonState): TaxonId[] {
  const start = state.taxa.get(taxonId);
  if (start === undefined) return [];
  const seen = new Set<TaxonId>();
  const out: TaxonId[] = [];
  const queue: TaxonId[] = Array.from(start.childIds);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    const t = state.taxa.get(id);
    if (t !== undefined) {
      for (const c of t.childIds) queue.push(c);
    }
  }
  return out;
}

/**
 * All roots from which `taxonId` is reachable downward. A taxon's
 * containing trees per §3.3.
 *
 * Computed by walking *upward* through the parents-of index until we hit
 * taxa with no parents (roots). Cycle-safe.
 *
 * If `taxonId` is itself a root with no parents, returns `[taxonId]` (it
 * is its own tree). Returns `[]` for an unknown id.
 */
export function treesContaining(taxonId: TaxonId, state: TaxonState): TaxonId[] {
  if (!state.taxa.has(taxonId)) return [];
  const seen = new Set<TaxonId>();
  const rootIds = new Set<TaxonId>();
  const stack: TaxonId[] = [taxonId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const parents = state.parentsOf.get(id);
    if (parents === undefined || parents.size === 0) {
      rootIds.add(id);
    } else {
      for (const p of parents) stack.push(p);
    }
  }
  // Return in creation order for deterministic output.
  const out: TaxonId[] = [];
  for (const t of state.taxa.values()) {
    if (rootIds.has(t.id)) out.push(t.id);
  }
  return out;
}

/**
 * §3.3: "A taxon is shared if it is reachable from more than one root."
 *
 * Note: a taxon reachable from the SAME root by two distinct paths
 * (an in-tree diamond, invariant 2 violation) is NOT shared — sharing
 * counts distinct trees, not paths. The duplicate-path case is reported
 * by the invariant module instead.
 */
export function isShared(taxonId: TaxonId, state: TaxonState): boolean {
  return treesContaining(taxonId, state).length > 1;
}

/**
 * Visit-count map for a single tree: for each taxon reachable downward
 * from `rootId`, the number of distinct paths from `rootId` to that taxon.
 * Built by a path-counting DFS that respects cycle-cutting (each edge
 * traversed at most once per path; revisits inside one path are dropped
 * to keep the count finite on cyclic fixture graphs).
 *
 * Used by:
 *   - the §15.2 GET /trees/{rootId} response builder, which finitizes
 *     re-expansion of a taxon visited via two paths in the same tree
 *     (a Phase-3-only concern — see initial test plan, decision #1),
 *   - the invariant module's per-tree-uniqueness check.
 *
 * Returned map's iteration is in discovery order.
 */
export function inTreeVisitCounts(
  rootId: TaxonId,
  state: TaxonState,
): Map<TaxonId, number> {
  const counts = new Map<TaxonId, number>();
  if (!state.taxa.has(rootId)) return counts;

  // Iterative DFS with an explicit path-stack so we can detect cycles
  // and avoid traversing the same path twice (which would double-count).
  // A taxon may be visited multiple times in total (that's the point —
  // we're *counting* paths) but never twice along the same root-to-here
  // ancestor chain.
  function walk(id: TaxonId, onPath: Set<TaxonId>): void {
    if (onPath.has(id)) {
      // Cycle. Don't recurse; don't count this revisit (counting it
      // would inflate to infinity on cycles in fixture graphs).
      return;
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
    onPath.add(id);
    const t = state.taxa.get(id);
    if (t !== undefined) {
      for (const c of t.childIds) {
        walk(c, onPath);
      }
    }
    onPath.delete(id);
  }
  walk(rootId, new Set());
  return counts;
}

/**
 * Within the tree rooted at `rootId`, the set of taxa reachable by more
 * than one path — i.e. invariant-2 violations within this tree.
 *
 * Returns ids in discovery order.
 */
export function inTreeDuplicates(rootId: TaxonId, state: TaxonState): TaxonId[] {
  const out: TaxonId[] = [];
  for (const [id, n] of inTreeVisitCounts(rootId, state)) {
    if (n > 1) out.push(id);
  }
  return out;
}
