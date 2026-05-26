// Proposal routes from PRD §15.4 (write) and §15.2 (reads).
//
//   POST /proposals          — submit a proposal (§15.4), proposer is the caller
//   GET  /proposals          — list proposals, optional ?proposer= filter (§15.2)
//   GET  /proposals/{id}     — §11.5 isomorphic status view (§15.2)
//
// Write goes through the §11.1 lock (same one Phase 4 introduced).
// Reads are open to all (including the null user) per §15.2; the
// identity gate still runs so a malformed X-Username 400s and an
// unregistered well-formed one 403s on the writes.
//
// Failure mapping (Phase-5 initial plan decisions #3–#5, #13):
//   parse failure kind 'validation_error' → 400
//   parse failure kind 'not_found'        → 404
//   parse failure kind 'conflict'         → 409

import { Hono } from "hono";

import { ApiError } from "../errors.js";
import type { AppEnv, Identity } from "../identity.js";
import { IDENTITY_KEY } from "../identity.js";
import { identityWithRegistry } from "../middleware/identity.js";
import { requireWriter } from "../middleware/requireWriter.js";
import {
  allProposals,
  getProposal,
  renderStatusTree,
  submitProposal,
  type Proposal,
} from "../proposals.js";
import { canonicalOf } from "../registry.js";
import { withWriteLock } from "../writeLock.js";

export const proposalsRouter = new Hono<AppEnv>();

const writerGates = [identityWithRegistry, requireWriter] as const;

function callerCanonical(identity: Identity): string {
  if (identity.kind !== "registered") {
    throw new ApiError(
      "forbidden",
      "writer middleware did not resolve a registered identity",
    );
  }
  return identity.username;
}

// --- POST /proposals  (§15.4) ----------------------------------------------

proposalsRouter.post("/proposals", ...writerGates, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError("validation_error", "request body must be valid JSON");
  }

  const proposer = callerCanonical(c.get(IDENTITY_KEY));

  const result = await withWriteLock(() => submitProposal(proposer, body));
  if (!result.ok) {
    const f = result.failure;
    switch (f.kind) {
      case "validation_error":
        throw new ApiError("validation_error", f.message);
      case "not_found":
        throw new ApiError("not_found", f.message);
      case "conflict":
        throw new ApiError("conflict", f.message, f.details);
    }
  }
  return c.json(renderProposal(result.proposal), 201);
});

// --- GET /proposals  (§15.2) -----------------------------------------------
//
// Open to all (null user allowed per §15.2). Optional `?proposer=<name>`
// filter; the name is matched case-insensitively against the registry's
// canonical form. An unregistered filter value returns an empty list
// (initial-plan decision #10): a filter is a query convenience, not a
// resource lookup.

proposalsRouter.get("/proposals", identityWithRegistry, (c) => {
  const filterRaw = c.req.query("proposer");
  let filter: string | null = null;
  let filterUnknown = false;
  if (filterRaw !== undefined) {
    const canonical = canonicalOf(filterRaw);
    if (canonical === null) {
      filterUnknown = true;
    } else {
      filter = canonical;
    }
  }

  if (filterUnknown) {
    return c.json({ proposals: [] });
  }

  const summaries = allProposals()
    .filter((p) => (filter === null ? true : p.proposer === filter))
    .map((p) => ({
      id: p.id,
      proposer: p.proposer,
      targetRootId: p.targetRootId,
      topTaxonId: p.topTaxonId,
    }));
  return c.json({ proposals: summaries });
});

// --- GET /proposals/{id}  (§15.2 + §11.5) ----------------------------------

proposalsRouter.get("/proposals/:id", identityWithRegistry, (c) => {
  const id = c.req.param("id");
  const p = getProposal(id);
  if (p === undefined) {
    throw new ApiError("not_found", `no such proposal: ${id}`);
  }
  return c.json(renderProposal(p));
});

// --- Helpers ---------------------------------------------------------------

function renderProposal(p: Proposal) {
  return {
    id: p.id,
    proposer: p.proposer,
    targetRootId: p.targetRootId,
    topTaxonId: p.topTaxonId,
    payload: renderStatusTree(p.payload, p),
  };
}
