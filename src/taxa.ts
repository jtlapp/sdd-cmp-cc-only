// In-memory taxon store from PRD §2 ("All state is held in memory") and
// §3.1 (taxon entity).
//
// A taxon has:
//   - a unique, server-assigned ID,
//   - a name (§3.4 format rules, but enforcement of the format lives in
//     validateTaxonName — Phase 1 — and is invoked by the writes Phase 4
//     adds; this module stores whatever string it is given),
//   - an owner (a non-null username; Phase 4 will validate the owner is
//     registered when it adds writes — fixtures may set any string),
//   - a set of child taxa (edges).
//
// The parent set is *derived*: it is the inverse of the child edges, not
// stored. The store maintains a reverse index for O(1) parent lookup but
// the source of truth is the child set on each taxon.
//
// IDs are opaque monotonic strings of the form t1, t2, ... — implementation
// defined per §2. POST /reset (registerReset, src/state.ts) clears the
// store AND resets the ID counter back to 0 so the next allocation is t1
// again. Tests must not assume specific IDs (toolchain supplement).
//
// Phase 3 ships NO mutation API on HTTP — this module is consumed only by
// the read routes (src/routes/reads.ts), the reachability layer
// (src/reachability.ts), and the invariant module (src/invariants.ts).
// Tests construct graphs via the fixture primitives below, which are
// deliberately non-validating so that tests can deliberately produce
// invariant-violating graphs to exercise the invariant module's negative
// paths. Phase 4 will introduce validating mutation paths layered on top.

import { registerReset } from "./state.js";

export type TaxonId = string;

export interface Taxon {
  readonly id: TaxonId;
  name: string;
  owner: string;
  // Children in insertion order (decision #4 of phase-3-initial.md).
  // The Set's iteration order is insertion order in V8 / Node; we rely on
  // that here, matching how Phase 2's registry uses Map ordering.
  readonly childIds: Set<TaxonId>;
}

// Read-only snapshot exposed to the reachability + invariant modules and to
// the read routes. They never mutate; the only writers are the fixture
// primitives below and (eventually, Phase 4) the validating mutation paths.
export interface TaxonState {
  /** All taxa keyed by id, in creation order. */
  readonly taxa: ReadonlyMap<TaxonId, Taxon>;
  /**
   * Reverse index: child id → set of parent ids, in attachment order
   * (each parent acquired this child in turn). Only contains entries for
   * taxa that actually have at least one parent — a root has no entry.
   */
  readonly parentsOf: ReadonlyMap<TaxonId, Set<TaxonId>>;
}

// --- Module-private storage ------------------------------------------------

const taxa = new Map<TaxonId, Taxon>();
const parentsOf = new Map<TaxonId, Set<TaxonId>>();

let idCounter = 0;

function nextId(): TaxonId {
  idCounter += 1;
  return `t${idCounter}`;
}

// --- Public read surface ---------------------------------------------------

/** Live snapshot — callers must not mutate. Cheap to call. */
export function getState(): TaxonState {
  return { taxa, parentsOf };
}

export function getTaxon(id: TaxonId): Taxon | undefined {
  return taxa.get(id);
}

export function allTaxa(): Taxon[] {
  return Array.from(taxa.values());
}

export function parentsOfTaxon(id: TaxonId): TaxonId[] {
  const set = parentsOf.get(id);
  return set ? Array.from(set) : [];
}

export function childrenOfTaxon(id: TaxonId): TaxonId[] {
  const t = taxa.get(id);
  return t ? Array.from(t.childIds) : [];
}

// --- Fixture-only construction (decision #8) -------------------------------
//
// These are deliberately non-validating. They do NOT enforce §3.3 invariants.
// They are used by Phase-3 tests to seed graphs (both valid and deliberately
// invalid). Phase 4 will add validating mutation paths that call into the
// invariant module before applying the same kind of state changes.
//
// Naming: the "Fixture" suffix is a deliberate signal that these are not the
// Phase-4 user-facing operations. If you find yourself wanting to call these
// from a route handler, you are almost certainly in the wrong place.

/**
 * Create a new taxon with a fresh server-assigned ID. The taxon starts as a
 * root with no children. Does NOT validate the name or owner — Phase 4
 * mutations will call validateTaxonName / registry checks first.
 */
export function createTaxonFixture(name: string, owner: string): Taxon {
  const id = nextId();
  const t: Taxon = { id, name, owner, childIds: new Set() };
  taxa.set(id, t);
  return t;
}

/**
 * Attach `childId` as a child of `parentId`. Idempotent on a duplicate edge
 * (Sets dedupe). Does NOT check for cycles, in-tree duplicates, or name
 * clashes — that's the invariant module's job.
 *
 * Throws if either id is unknown — this is a fixture-author bug, not a
 * domain invariant violation.
 */
export function attachChildFixture(parentId: TaxonId, childId: TaxonId): void {
  const parent = taxa.get(parentId);
  if (parent === undefined) {
    throw new Error(`attachChildFixture: unknown parent ${parentId}`);
  }
  if (!taxa.has(childId)) {
    throw new Error(`attachChildFixture: unknown child ${childId}`);
  }
  parent.childIds.add(childId);
  let parents = parentsOf.get(childId);
  if (parents === undefined) {
    parents = new Set();
    parentsOf.set(childId, parents);
  }
  parents.add(parentId);
}

/**
 * Remove the parent→child edge if it exists. No-op if it doesn't.
 * Mirrors attachChildFixture: fixtures use this to detach a single edge
 * without performing a §6.3-style cascade delete.
 */
export function detachChildFixture(parentId: TaxonId, childId: TaxonId): void {
  const parent = taxa.get(parentId);
  if (parent !== undefined) {
    parent.childIds.delete(childId);
  }
  const parents = parentsOf.get(childId);
  if (parents !== undefined) {
    parents.delete(parentId);
    if (parents.size === 0) {
      parentsOf.delete(childId);
    }
  }
}

/**
 * Remove a taxon entirely: drop it from the taxa map, remove every edge
 * referencing it (from parents' childIds and from children's parents-of
 * sets), and drop its own parents-of entry. No-op on unknown id.
 *
 * Used by the Phase-4 delete cascade (src/deletion.ts) to apply a planned
 * region removal: detaching incoming and outgoing edges falls out of the
 * removal naturally, so the cascade is just a loop of removeTaxonFixture
 * calls over the region.
 *
 * Like attach/detachChildFixture, this performs NO domain validation —
 * the deletion planner is responsible for §6.3 preconditions before any
 * remove is applied.
 */
export function removeTaxonFixture(id: TaxonId): void {
  const t = taxa.get(id);
  if (t === undefined) return;
  // Remove every incoming edge: for each parent that points at id, drop
  // id from that parent's childIds.
  const parents = parentsOf.get(id);
  if (parents !== undefined) {
    for (const pid of parents) {
      const p = taxa.get(pid);
      if (p !== undefined) p.childIds.delete(id);
    }
  }
  // Remove every outgoing edge: for each child of id, drop id from that
  // child's parents-of set (and clean up an emptied set).
  for (const cid of t.childIds) {
    const childParents = parentsOf.get(cid);
    if (childParents !== undefined) {
      childParents.delete(id);
      if (childParents.size === 0) parentsOf.delete(cid);
    }
  }
  // Finally drop the taxon and its parents-of entry.
  parentsOf.delete(id);
  taxa.delete(id);
}

// --- Reset -----------------------------------------------------------------

export function clear(): void {
  taxa.clear();
  parentsOf.clear();
  idCounter = 0;
}

registerReset(clear);
