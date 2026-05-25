// Direct-action write endpoints from PRD §15.3, behavior per §5–§7.
//
//   POST   /taxa                                 — §6.1 create
//   PATCH  /taxa/{id}                            — §6.2 edit (name and/or owner)
//   DELETE /taxa/{id}                            — §6.3 delete + cascade
//   PUT    /taxa/{parentId}/children/{childId}   — §6.4 add edge
//   DELETE /taxa/{parentId}/children/{childId}   — §6.4 remove edge (detach)
//
// All handlers run under §11.1 write serialization via withWriteLock. Every
// invariant check is delegated to the Phase-3 invariant module (evaluateAll
// over a candidate state). The mutation pattern across all four handlers
// is identical:
//
//   1. (Middleware) identityWithRegistry → requireWriter. By the time we're
//      here the caller is a registered, non-null user; malformed/unregistered/
//      null have already 400'd or 403'd.
//   2. Parse the body (POST/PATCH only). Body-shape problems → 400.
//   3. Acquire the write lock and, inside the critical section:
//      a. Look up resources by id — missing → 404.
//      b. Authorize against the relevant owner (taxon's owner for edit /
//         delete, parent's owner for edge ops) — non-match → 403.
//      c. Validate body fields (PATCH only; name format, owner registry) — 400.
//      d. Apply tentatively, run evaluateAll on the candidate state, roll back
//         on violation — conflict → 409. Apply the deletion plan likewise.
//   4. Return the response (201 / 200 / 204).
//
// This ordering matches resolved decision #5 of phase-4-initial.md.

import { Hono } from "hono";

import { planDeletion } from "../deletion.js";
import { ApiError } from "../errors.js";
import { evaluateAll, type Violation } from "../invariants.js";
import { canonicalOf } from "../registry.js";
import { validateTaxonName } from "../validation/taxonName.js";
import { parseUsername } from "../validation/username.js";
import {
  attachChildFixture,
  createTaxonFixture,
  detachChildFixture,
  getState,
  getTaxon,
  parentsOfTaxon,
  removeTaxonFixture,
} from "../taxa.js";
import type { Taxon, TaxonId } from "../taxa.js";
import { withWriteLock } from "../writeLock.js";
import type { AppEnv, Identity } from "../identity.js";
import { IDENTITY_KEY } from "../identity.js";
import { identityWithRegistry } from "../middleware/identity.js";
import { requireWriter } from "../middleware/requireWriter.js";
import type { DeletionViolation } from "../deletion.js";

export const writesRouter = new Hono<AppEnv>();

// Both gates are applied per-handler rather than via writesRouter.use(...),
// because a path-wide use() would also match GETs (whose handlers live in
// readsRouter) and other write methods we don't define, breaking the
// Phase-1 catch-all 404 on unknown paths like /taxa/some/deeper/path.
//
// Order matters: identityWithRegistry first (malformed X-Username → 400,
// unregistered → 403), then requireWriter (null → 403). A malformed-but-
// null-equivalent header still surfaces as 400.
const writerGates = [identityWithRegistry, requireWriter] as const;

// --- Response shape (mirrors Phase-3 reads) --------------------------------

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

// By the time a handler runs, the middleware stack has resolved identity
// to `{kind: "registered", username: <canonical>}`. requireWriter has
// already rejected the null case.
function callerCanonical(identity: Identity): string {
  if (identity.kind !== "registered") {
    // Defensive: requireWriter should make this unreachable.
    throw new ApiError("forbidden", "writer middleware did not resolve a registered identity");
  }
  return identity.username;
}

async function parseJsonObject(c: {
  req: { json(): Promise<unknown> };
}): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError("validation_error", "request body must be valid JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("validation_error", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

// --- POST /taxa  (§6.1) ----------------------------------------------------
//
// Creates a fresh root taxon owned by the caller. Body: { name }. Other
// fields (including "owner") are ignored — §6.1 fixes the creator as the
// owner; clients can't pre-assign.

writesRouter.post("/taxa", ...writerGates, async (c) => {
  const obj = await parseJsonObject(c);
  const v = validateTaxonName(obj.name);
  if (!v.ok) throw new ApiError("validation_error", v.reason);
  const owner = callerCanonical(c.get(IDENTITY_KEY));

  const taxon = await withWriteLock(() => createTaxonFixture(v.value, owner));
  return c.json(recordOf(taxon), 201);
});

// --- PATCH /taxa/{id}  (§6.2) ----------------------------------------------
//
// Body: { name?, owner? } — at least one required (decision #1: empty body
// → 400). Unknown keys are ignored (decision #6). When name changes, the
// invariant module re-runs against the candidate state and catches name
// clashes in EVERY containing tree (the §3.3 cross-tree path).

writesRouter.patch("/taxa/:id", ...writerGates, async (c) => {
  const id = c.req.param("id");
  const obj = await parseJsonObject(c);
  const hasName = Object.prototype.hasOwnProperty.call(obj, "name");
  const hasOwner = Object.prototype.hasOwnProperty.call(obj, "owner");
  if (!hasName && !hasOwner) {
    throw new ApiError(
      "validation_error",
      "PATCH body must include 'name' and/or 'owner'",
    );
  }

  let newName: string | undefined;
  if (hasName) {
    const v = validateTaxonName(obj.name);
    if (!v.ok) throw new ApiError("validation_error", v.reason);
    newName = v.value;
  }

  let newOwner: string | undefined;
  if (hasOwner) {
    newOwner = validateOwnerField(obj.owner);
  }

  const caller = callerCanonical(c.get(IDENTITY_KEY));

  const updated = await withWriteLock(() => {
    const t = getTaxon(id);
    if (t === undefined) {
      throw new ApiError("not_found", `no such taxon: ${id}`);
    }
    if (t.owner !== caller) {
      throw new ApiError(
        "forbidden",
        `caller ${caller} is not the owner of taxon ${id}`,
      );
    }

    // Apply tentatively against live state. Owner alone can't trip a §3.3
    // invariant; only the name change needs evaluateAll.
    const origName = t.name;
    const origOwner = t.owner;
    if (newName !== undefined) t.name = newName;
    if (newOwner !== undefined) t.owner = newOwner;

    if (newName !== undefined) {
      const result = evaluateAll(getState());
      if (!result.ok) {
        // Roll back, then surface the most relevant violation. Only a
        // name change is possible here, so prefer name_clash if present.
        t.name = origName;
        t.owner = origOwner;
        const v = result.violations.find((x) => x.kind === "name_clash") ?? result.violations[0];
        throw conflictFromViolation(v, "edit");
      }
    }
    return recordOf(t);
  });

  return c.json(updated);
});

// --- DELETE /taxa/{id}  (§6.3) ---------------------------------------------
//
// Owner-authoritative delete with the §6.3 cascade. Region computation
// halts at and detaches other-owned taxa; §14 bullet 4's "stranded U-owned
// descendants beneath an other-owned halt point" is intentional and
// surfaces as untouched downstream state.

writesRouter.delete("/taxa/:id", ...writerGates, async (c) => {
  const id = c.req.param("id");
  const caller = callerCanonical(c.get(IDENTITY_KEY));

  await withWriteLock(() => {
    const t = getTaxon(id);
    if (t === undefined) {
      throw new ApiError("not_found", `no such taxon: ${id}`);
    }
    if (t.owner !== caller) {
      throw new ApiError(
        "forbidden",
        `caller ${caller} is not the owner of taxon ${id}`,
      );
    }
    const result = planDeletion(id, caller, getState());
    if (!result.ok) {
      throw conflictFromDeletionViolation(result.violation);
    }
    // Apply: remove every region taxon. removeTaxonFixture cleans up every
    // referencing edge (incoming + outgoing), so halt-frontier other-owned
    // children naturally lose their edge to their (now-deleted) region
    // parent without any extra step.
    for (const rid of result.plan.region) {
      removeTaxonFixture(rid);
    }
  });

  return c.body(null, 204);
});

// --- PUT /taxa/{parentId}/children/{childId}  (§6.4 add) -------------------

writesRouter.put("/taxa/:parentId/children/:childId", ...writerGates, async (c) => {
  const parentId = c.req.param("parentId");
  const childId = c.req.param("childId");
  const caller = callerCanonical(c.get(IDENTITY_KEY));

  await withWriteLock(() => {
    const parent = getTaxon(parentId);
    if (parent === undefined) {
      throw new ApiError("not_found", `no such taxon (parent): ${parentId}`);
    }
    const child = getTaxon(childId);
    if (child === undefined) {
      throw new ApiError("not_found", `no such taxon (child): ${childId}`);
    }
    if (parent.owner !== caller) {
      throw new ApiError(
        "forbidden",
        `caller ${caller} is not the owner of parent ${parentId}`,
      );
    }
    if (parent.childIds.has(childId)) {
      // Idempotent: edge already exists (decision #2). No invariant check
      // needed — state is unchanged.
      return;
    }
    attachChildFixture(parentId, childId);
    const result = evaluateAll(getState());
    if (!result.ok) {
      detachChildFixture(parentId, childId);
      throw conflictFromViolation(result.violations[0], "edge_add");
    }
  });

  return c.body(null, 204);
});

// --- DELETE /taxa/{parentId}/children/{childId}  (§6.4 detach) -------------
//
// Pure edge removal — never invariant-checking (removing an edge can't
// create a cycle, duplicate, or name clash). Per decision #3, the edge
// must exist; absence → 404.

writesRouter.delete("/taxa/:parentId/children/:childId", ...writerGates, async (c) => {
  const parentId = c.req.param("parentId");
  const childId = c.req.param("childId");
  const caller = callerCanonical(c.get(IDENTITY_KEY));

  await withWriteLock(() => {
    const parent = getTaxon(parentId);
    if (parent === undefined) {
      throw new ApiError("not_found", `no such taxon (parent): ${parentId}`);
    }
    const child = getTaxon(childId);
    if (child === undefined) {
      throw new ApiError("not_found", `no such taxon (child): ${childId}`);
    }
    if (parent.owner !== caller) {
      throw new ApiError(
        "forbidden",
        `caller ${caller} is not the owner of parent ${parentId}`,
      );
    }
    if (!parent.childIds.has(childId)) {
      throw new ApiError(
        "not_found",
        `no edge from ${parentId} to ${childId}`,
      );
    }
    detachChildFixture(parentId, childId);
  });

  return c.body(null, 204);
});

// --- Helpers ---------------------------------------------------------------

function validateOwnerField(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ApiError("validation_error", "owner must be a string");
  }
  if (raw === "") {
    throw new ApiError("validation_error", "owner must not be empty");
  }
  const parsed = parseUsername(raw);
  if (parsed.kind === "malformed") {
    throw new ApiError("validation_error", `owner: ${parsed.reason}`);
  }
  if (parsed.kind === "null") {
    // Unreachable given the empty-string guard, but kept for total coverage.
    throw new ApiError("validation_error", "owner must not be empty");
  }
  const canonical = canonicalOf(parsed.value);
  if (canonical === null) {
    throw new ApiError(
      "validation_error",
      `owner is not a registered user: ${parsed.value}`,
    );
  }
  return canonical;
}

// Convert a Phase-3 invariant violation into a §15.6 conflict envelope.
// The `op` tag distinguishes "edit" (rename clash) from "edge_add" (cycle /
// in-tree duplicate / name clash) in the message; details carries the
// structural offender so a client can react programmatically.
function conflictFromViolation(v: Violation, op: "edit" | "edge_add"): ApiError {
  switch (v.kind) {
    case "cycle":
      return new ApiError(
        "conflict",
        `${op}: would create a cycle through [${v.taxa.join(", ")}]`,
        { kind: "cycle", taxa: v.taxa },
      );
    case "in_tree_duplicate":
      return new ApiError(
        "conflict",
        `${op}: taxon ${v.taxonId} would be reachable by more than one path in tree ${v.rootId}`,
        { kind: "in_tree_duplicate", rootId: v.rootId, taxonId: v.taxonId },
      );
    case "name_clash":
      return new ApiError(
        "conflict",
        `${op}: name "${v.name}" clashes within tree ${v.rootId} between [${v.taxa.join(", ")}]`,
        { kind: "name_clash", rootId: v.rootId, name: v.name, taxa: v.taxa },
      );
  }
}

function conflictFromDeletionViolation(v: DeletionViolation): ApiError {
  switch (v.kind) {
    case "shared_in_region":
      return new ApiError(
        "conflict",
        `delete: taxon ${v.taxonId} in the deletion region is shared (reachable from more than one root)`,
        { kind: "shared_in_region", taxonId: v.taxonId },
      );
    case "parent_not_owned":
      return new ApiError(
        "conflict",
        `delete: target's parent ${v.parentId} is owned by ${v.parentOwner}, not the deleter`,
        { kind: "parent_not_owned", parentId: v.parentId, parentOwner: v.parentOwner },
      );
    case "multiple_parents":
      return new ApiError(
        "conflict",
        `delete: target has multiple parents [${v.parentIds.join(", ")}]`,
        { kind: "multiple_parents", parentIds: v.parentIds },
      );
  }
}
