// Invariant module from PRD §3.3 — the keystone of Phase 3.
//
// PURE. No I/O, no mutation, no HTTP. Operates on a TaxonState snapshot
// (which the caller may construct as "live state" or as a candidate
// "live + proposed change"). Every later write path will call into this
// module rather than re-implementing any invariant check.
//
// The three §3.3 invariants:
//   1. No cycles. The graph is acyclic.
//   2. Per-tree uniqueness of occurrence. Within any single tree, no
//      taxon is reachable by more than one path.
//   3. Per-tree name uniqueness. Within any single tree, no two distinct
//      taxa share the same name (compared case-insensitively per §3.4).
//      Names are GLOBAL properties of a taxon, so a rename must satisfy
//      this in EVERY tree containing the taxon — evaluateAll catches
//      that cross-tree case for free by checking every tree.
//
// Result shape (decision #10 of phase-3-initial.md):
//   - evaluateAll(state) returns { ok: true } on a clean graph, or
//     { ok: false, violations: [...] } where each violation carries the
//     invariant kind + offender details Phase 4 can surface as §15.6
//     conflict reasons. Tests pin the shape so future refactors don't
//     silently lose information.

import { inTreeVisitCounts, roots } from "./reachability.js";
import { taxonNamesEqual } from "./validation/taxonName.js";
import type { TaxonId, TaxonState } from "./taxa.js";

export type Violation =
  | {
      kind: "cycle";
      /** Taxa that participate in the cycle, in discovery order. */
      taxa: TaxonId[];
    }
  | {
      kind: "in_tree_duplicate";
      /** The root of the tree in which the duplication occurs. */
      rootId: TaxonId;
      /** The taxon reachable by more than one path from that root. */
      taxonId: TaxonId;
    }
  | {
      kind: "name_clash";
      /** The root of the tree in which the clash occurs. */
      rootId: TaxonId;
      /** The case-insensitive name (lowercased) that collides. */
      name: string;
      /** The two-or-more taxa carrying that name in this tree. */
      taxa: TaxonId[];
    };

export type InvariantResult =
  | { ok: true }
  | { ok: false; violations: Violation[] };

// --- Invariant 1: no cycles ------------------------------------------------
//
// A cycle exists iff some taxon is its own descendant. We detect this with
// the classic three-color DFS (white = unvisited, gray = on current path,
// black = fully explored). A gray-target edge is a back-edge and proves a
// cycle.
//
// We report one violation per detected back-edge, listing the taxa on the
// path from the cycle's entry point through the back-edge's source. Tests
// only assert participation, not a specific cycle ordering.

export function checkNoCycles(state: TaxonState): Violation[] {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<TaxonId, number>();
  for (const id of state.taxa.keys()) color.set(id, WHITE);

  const out: Violation[] = [];
  const reported = new Set<string>(); // dedupe by stringified cycle

  const path: TaxonId[] = [];
  function visit(id: TaxonId): void {
    color.set(id, GRAY);
    path.push(id);
    const t = state.taxa.get(id);
    if (t !== undefined) {
      for (const c of t.childIds) {
        const cc = color.get(c);
        if (cc === WHITE) {
          visit(c);
        } else if (cc === GRAY) {
          // Back-edge id → c found a cycle. Slice the path from c onward.
          const start = path.indexOf(c);
          const cycle = start >= 0 ? path.slice(start) : [c, id];
          const key = [...cycle].sort().join(",");
          if (!reported.has(key)) {
            reported.add(key);
            out.push({ kind: "cycle", taxa: cycle });
          }
        }
        // BLACK: already fully explored, no cycle through here from id.
      }
    }
    path.pop();
    color.set(id, BLACK);
  }

  for (const id of state.taxa.keys()) {
    if (color.get(id) === WHITE) visit(id);
  }
  return out;
}

// --- Invariant 2: per-tree uniqueness of occurrence ------------------------
//
// For each root, count how many distinct paths reach each descendant. Any
// count > 1 within a single tree is a violation (a diamond *within* that
// tree). Diamonds *across* different trees are permitted (and surface as
// `isShared`, not as a violation).
//
// Note: on a cyclic graph, path-counting is finitized by inTreeVisitCounts
// (it refuses to recurse along an ancestor chain it's already on). Cycles
// are reported by invariant 1; we don't double-report them here.

export function checkPerTreeUniqueOccurrence(state: TaxonState): Violation[] {
  const out: Violation[] = [];
  for (const rootId of roots(state)) {
    const counts = inTreeVisitCounts(rootId, state);
    for (const [id, n] of counts) {
      if (n > 1) {
        out.push({ kind: "in_tree_duplicate", rootId, taxonId: id });
      }
    }
  }
  return out;
}

// --- Invariant 3: per-tree name uniqueness (case-insensitive) --------------
//
// For each root, group reachable taxa by lowercased name. Any group with
// two or more taxa is a clash. Because we iterate every root, a rename
// that satisfies the invariant in its "own" tree but breaks it in another
// containing tree shows up as a violation under that other tree —
// implementing §3.3's "must satisfy invariant (3) in ALL containing trees"
// for renames for free.
//
// We deduplicate the taxa in each clash bucket because the same taxon can
// appear multiple times if it's in an in-tree diamond — that's invariant 2's
// concern. Reporting a name "clashing with itself" would be a false
// positive here.

export function checkPerTreeNameUniqueness(state: TaxonState): Violation[] {
  const out: Violation[] = [];
  for (const rootId of roots(state)) {
    const counts = inTreeVisitCounts(rootId, state);
    const buckets = new Map<string, Set<TaxonId>>();
    for (const id of counts.keys()) {
      const t = state.taxa.get(id);
      if (t === undefined) continue;
      const key = t.name.toLowerCase();
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = new Set();
        buckets.set(key, bucket);
      }
      bucket.add(id);
    }
    for (const [key, ids] of buckets) {
      if (ids.size > 1) {
        out.push({ kind: "name_clash", rootId, name: key, taxa: Array.from(ids) });
      }
    }
  }
  return out;
}

// --- Combined evaluator ----------------------------------------------------
//
// Runs all three checks against the same state and returns either ok:true
// or ok:false with the full list of violations. Phase 4 will use the
// violations array to build a §15.6 conflict response — the structure is
// designed so a caller can pick a single offender to surface in the
// `message` and keep the rest in `details`.

export function evaluateAll(state: TaxonState): InvariantResult {
  const violations: Violation[] = [
    ...checkNoCycles(state),
    ...checkPerTreeUniqueOccurrence(state),
    ...checkPerTreeNameUniqueness(state),
  ];
  return violations.length === 0
    ? { ok: true }
    : { ok: false, violations };
}

// Re-export the comparator from validation/taxonName for callers that need
// the same case-insensitive comparison rule §3.4 specifies. The invariant
// module itself uses .toLowerCase() inline (cheaper than taxonNamesEqual
// when grouping into buckets), but external callers should prefer the
// named helper to keep the rule centralized.
export { taxonNamesEqual };
