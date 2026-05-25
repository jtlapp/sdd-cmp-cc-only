// Delete-region computation from PRD §6.3 + §7.
//
// "Define the deletion region of a delete of taxon N by user U as: N itself,
//  plus every descendant reachable from N by a path passing EXCLUSIVELY
//  through taxa owned by U. The cascade HALTS upon encountering a taxon
//  owned by another user: that other-owned taxon is NOT deleted — instead
//  the edge from its (deleted, U-owned) parent is removed, so it DETACHES
//  from this tree (surviving as a root if it has no other parents).
//  Crucially, the cascade does NOT continue past such a taxon: any
//  further-downstream taxa, EVEN those owned by U, are NOT deleted, because
//  they are no longer reachable through a wholly-U-owned path."
//
// Pure planner — computes the region + the §6.3 precondition outcome over a
// TaxonState snapshot. The mutation layer applies the plan via
// removeTaxonFixture (which naturally cleans up halt-frontier edges as a
// side effect of removing the region taxa).

import { isShared } from "./reachability.js";
import type { TaxonId, TaxonState } from "./taxa.js";

export type DeletionViolation =
  | {
      /** A taxon in the deletion region is shared (reachable from > 1 root). */
      kind: "shared_in_region";
      taxonId: TaxonId;
    }
  | {
      /**
       * N has at least one parent NOT owned by U. (Given precondition 1 is
       * satisfied, N has at most one parent — so this also covers the
       * "wrong single parent" case.)
       */
      kind: "parent_not_owned";
      parentId: TaxonId;
      parentOwner: string;
    }
  | {
      /**
       * N has multiple parents. Under invariant-2-clean state with
       * precondition 1 also satisfied this can't actually arise (multiple
       * parents → multiple roots → N would be shared and trigger
       * shared_in_region first), but we report it explicitly to keep
       * precondition 2's literal wording ("no parent, OR has exactly one
       * parent owned by U") verifiable independently.
       */
      kind: "multiple_parents";
      parentIds: TaxonId[];
    };

export interface DeletionPlan {
  /** Taxa that will be removed (includes N). Discovery order, N first. */
  region: TaxonId[];
}

export type DeletionResult =
  | { ok: true; plan: DeletionPlan }
  | { ok: false; violation: DeletionViolation };

/**
 * Plan a delete of `id` by user `owner` (canonical username), against the
 * given state. Returns the deletion region + precondition outcome.
 *
 * Caller is responsible for:
 *   - Verifying `id` exists (this returns ok with region: [id] for a leaf
 *     taxon as long as preconditions pass; the precondition checks assume
 *     the taxon exists).
 *   - Verifying the caller IS `owner` (the auth check). This planner just
 *     consumes the owner string and computes the region from it.
 */
export function planDeletion(
  id: TaxonId,
  owner: string,
  state: TaxonState,
): DeletionResult {
  // --- Region walk -------------------------------------------------------
  //
  // BFS from N. A taxon enters the region iff it is owned by U; on
  // encountering an other-owned taxon, we do NOT include it and do NOT
  // recurse past it (this is the halt-and-strand behavior — §14 bullet 4).
  // The starting taxon `id` is always included (the caller has already
  // checked auth, so we trust that id is owned by `owner`).
  const region: TaxonId[] = [];
  const inRegion = new Set<TaxonId>();
  const queue: TaxonId[] = [id];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (inRegion.has(cur)) continue;
    const t = state.taxa.get(cur);
    if (t === undefined) continue;
    inRegion.add(cur);
    region.push(cur);
    for (const childId of t.childIds) {
      const child = state.taxa.get(childId);
      if (child === undefined) continue;
      if (child.owner !== owner) {
        // Halt: child is the boundary. Edge will be detached by the apply
        // step when its (region) parent is removed; child is NOT in
        // region, NOT walked past.
        continue;
      }
      if (!inRegion.has(childId)) queue.push(childId);
    }
  }

  // --- Precondition 1: no taxon in the region is shared ------------------
  //
  // §6.3: "no taxon that would actually be deleted is reachable from more
  //  than one root." Other-owned halt-frontier taxa are NOT in the region
  //  and thus may be shared without tripping this — they are merely
  //  detached, which is non-destructive.
  for (const rid of region) {
    if (isShared(rid, state)) {
      return { ok: false, violation: { kind: "shared_in_region", taxonId: rid } };
    }
  }

  // --- Precondition 2: N has no parent, or one parent owned by U ---------
  const parents = state.parentsOf.get(id);
  if (parents !== undefined && parents.size > 0) {
    if (parents.size > 1) {
      return {
        ok: false,
        violation: { kind: "multiple_parents", parentIds: Array.from(parents) },
      };
    }
    const [parentId] = parents;
    const parent = state.taxa.get(parentId);
    if (parent === undefined) {
      // Defensive: parentsOf points to a missing taxon. Treat as no-parent
      // (parent_not_owned can't be reported without an owner string).
      // This shouldn't happen on a Phase-4-managed graph.
    } else if (parent.owner !== owner) {
      return {
        ok: false,
        violation: {
          kind: "parent_not_owned",
          parentId,
          parentOwner: parent.owner,
        },
      };
    }
  }

  return { ok: true, plan: { region } };
}
