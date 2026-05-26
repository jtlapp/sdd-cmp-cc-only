// Proposal subsystem from PRD §8–§11 (Phase 5 slice).
//
// In Phase 5 we accept proposals, parse the payload tree, derive
// individually-routed changes, classify dependencies per §10.2, and compute
// each change's INITIAL disposition (latent vs. queued) per §11.3. No
// promotion, acceptance, rejection, invalidation, or cascade happens yet —
// all of that is deferred to Phases 6–7.
//
// This module is PURE+STATE: schema/validation/routing logic is pure
// (takes a TaxonState snapshot), and the resulting Proposal records are
// then committed into module-local storage under the §11.1 write lock
// (the route layer wraps the call). The reset seam clears all proposal
// state and the change-id counter (decision #15 of the Phase-5 initial
// plan).
//
// Data model:
//   Proposal      — one submitted proposal (id, proposer, target, payload tree)
//   PayloadNode   — one node in the parsed payload tree, with an internal
//                   id for status-view isomorphism (§11.5) and, on
//                   operative nodes, a pointer to the derived Change.
//   Change        — one operative payload node turned into a routed,
//                   dispositioned unit. Phase 5 only ever produces
//                   "latent" or "queued" states.
//
// Routing per §10.1 is computed at submission for QUEUED changes (we
// always know the reviewer at submission because the routing target
// taxon — either the renamed taxon or the payload-parent taxon — is
// guaranteed to exist by submission-time validation). LATENT changes
// get reviewer=null in Phase 5; promotion in Phase 6+ will resolve it
// at the point of acceptance (relevant when the payload-parent is an
// add-create whose new owner is the accepting reviewer).

import { descendants } from "./reachability.js";
import { registerReset } from "./state.js";
import { getState, getTaxon } from "./taxa.js";
import type { TaxonId, TaxonState } from "./taxa.js";
import { validateTaxonName } from "./validation/taxonName.js";

// --- Public types ----------------------------------------------------------

export type ProposalId = string;
export type ChangeId = string;
export type InternalNodeId = string;

export type Op = "no-op" | "rename" | "add" | "detach";

export type ChangeState =
  | "latent"
  | "queued"
  | "accepted"
  | "rejected"
  | "invalid";

/** The dispositions §11.5 surfaces on the status view. `structural` is
 *  the dedicated value for no-op payload taxa (initial-plan decision #7). */
export type Disposition = ChangeState | "structural";

export interface PayloadNode {
  /** Server-assigned, proposal-local. Pairs payload nodes with their
   *  derived change (if any) and lets the status view be built
   *  isomorphic to the submitted payload. Never exposed externally. */
  readonly internalId: InternalNodeId;
  readonly op: Op;
  /** For no-op/rename/detach/graft: the taxon id (required, non-null).
   *  For add-create: null. */
  readonly id: TaxonId | null;
  /** For rename and add-create: the proposed/new name. For other ops:
   *  ignored at the wire layer per §9.1; we don't carry it. */
  readonly name?: string;
  readonly children: PayloadNode[];
  /** Present iff this node is operative (op !== "no-op"). */
  readonly changeId?: ChangeId;
}

export interface Change {
  readonly id: ChangeId;
  readonly proposalId: ProposalId;
  readonly op: "rename" | "add" | "detach";
  /** The payload path from top to (and including) this node, in
   *  internalIds — the §10.2 "payload path" used for dependency
   *  classification. */
  readonly payloadPath: InternalNodeId[];
  /** True iff at least one ancestor on the payload path is an `add`
   *  (create or graft). Equivalently: has a decision dependency.
   *  §11.3 says queued ⇔ this is false at submission. */
  readonly hasDecisionDepAncestor: boolean;
  /** Change id of the **nearest** add/graft ancestor on the payload
   *  path, or null if none. Used by Phase 6 promotion to find a change's
   *  direct dependents: when add A is accepted, the changes promoted
   *  are exactly those whose `nearestAddAncestorChangeId === A.id`. */
  readonly nearestAddAncestorChangeId: ChangeId | null;
  /** For rename: the renamed taxon. For add-graft: the grafted taxon.
   *  For add-create: undefined. For detach: the detached taxon. */
  readonly taxonId?: TaxonId;
  /** For rename, add-create: the proposed name. */
  readonly name?: string;
  /** For add/detach: the parent taxon under which the op acts.
   *  Undefined when the payload-parent is an add-create (id null) AND
   *  that add-create hasn't been accepted yet. When the parent
   *  add-create is accepted (Phase 6 promotion), the newly-minted
   *  taxon id is patched in here so routing can be resolved. */
  payloadParentTaxonId?: TaxonId;
  /** The target tree's root id. Echoed for /queue convenience. */
  readonly targetRootId: TaxonId;
  /** The reviewer per §10.1 (canonical username) for QUEUED changes.
   *  null for latent in Phase 5 — promotion (Phase 6) resolves it. */
  reviewer: string | null;
  state: ChangeState;
  /** Set after acceptance. For add-create, the newly-minted taxon's id;
   *  for add-graft / rename / detach, equals the pre-existing taxon id
   *  this change refers to. Lets Phase 6's promotion walk recover the
   *  live id of an accepted add-create when resolving downstream
   *  routing or existence-dep checks. */
  liveTaxonId?: TaxonId;
  /** §11.5 reason on negative states (rejected / invalid). Phase 6
   *  populates this only for the `invalid` state (rejection-propagation
   *  cause, or promotion-time existence-dep failure). */
  reason?: string;
}

export interface Proposal {
  readonly id: ProposalId;
  readonly proposer: string;
  readonly targetRootId: TaxonId;
  readonly topTaxonId: TaxonId;
  readonly payload: PayloadNode;
  /** Keyed by change id, iteration order = creation order. */
  readonly changes: Map<ChangeId, Change>;
  /** Every payload node in the proposal, keyed by its internalId.
   *  Built once at submission so Phase-6 promotion can walk the
   *  payload subtree below an accepted change without re-traversing
   *  the whole payload. */
  readonly nodesByInternalId: Map<InternalNodeId, PayloadNode>;
}

/** §15.6 maps each of these to its HTTP status the same way the rest of
 *  the system does — the route layer rethrows as ApiError. Carrying a
 *  discriminated kind here keeps this module decoupled from Hono and
 *  from the error envelope helpers. */
export type ParseFailure =
  | { kind: "validation_error"; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "conflict"; message: string; details?: Record<string, unknown> };

export type ParseResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; failure: ParseFailure };

// --- Module-private storage ------------------------------------------------

const proposals = new Map<ProposalId, Proposal>();
/** Reverse index: change id → its proposal, for O(1) change lookup. */
const changeIndex = new Map<ChangeId, Change>();
/** Per-reviewer queue: canonical username → ordered list of change ids
 *  (insertion order = submission order across all proposals). Only
 *  populated for QUEUED changes; latent changes are not enqueued. */
const queuesByReviewer = new Map<string, ChangeId[]>();

let proposalCounter = 0;
let changeCounter = 0;
let internalNodeCounter = 0;

function nextProposalId(): ProposalId {
  proposalCounter += 1;
  return `p${proposalCounter}`;
}
function nextChangeId(): ChangeId {
  changeCounter += 1;
  return `c${changeCounter}`;
}
function nextInternalNodeId(): InternalNodeId {
  internalNodeCounter += 1;
  return `n${internalNodeCounter}`;
}

export function clear(): void {
  proposals.clear();
  changeIndex.clear();
  queuesByReviewer.clear();
  proposalCounter = 0;
  changeCounter = 0;
  internalNodeCounter = 0;
}

registerReset(clear);

// --- Public read surface ---------------------------------------------------

export function getProposal(id: ProposalId): Proposal | undefined {
  return proposals.get(id);
}

export function allProposals(): Proposal[] {
  return Array.from(proposals.values());
}

export function queuedChangesFor(reviewer: string): Change[] {
  const ids = queuesByReviewer.get(reviewer);
  if (ids === undefined) return [];
  const out: Change[] = [];
  for (const id of ids) {
    const c = changeIndex.get(id);
    // Defensive: a change in the queue list whose state has drifted off
    // "queued" (e.g. invalidated via rejection-propagation in Phase 6)
    // is filtered here rather than relying on every mutation path to
    // also splice the list. The mutators below DO splice on transition,
    // so this is belt-and-suspenders.
    if (c !== undefined && c.state === "queued") out.push(c);
  }
  return out;
}

/** Lookup by change id. Returns undefined for unknown ids. */
export function getChange(id: ChangeId): Change | undefined {
  return changeIndex.get(id);
}

/** Append `changeId` to `reviewer`'s queue if not already present.
 *  Used by Phase 6 promotion to enqueue a newly-promoted change. */
export function enqueueChange(changeId: ChangeId, reviewer: string): void {
  let q = queuesByReviewer.get(reviewer);
  if (q === undefined) {
    q = [];
    queuesByReviewer.set(reviewer, q);
  }
  if (!q.includes(changeId)) q.push(changeId);
}

/** Remove `changeId` from `reviewer`'s queue if present. No-op otherwise.
 *  Used by Phase 6 accept/reject/invalidation to dequeue. */
export function dequeueChange(changeId: ChangeId, reviewer: string): void {
  const q = queuesByReviewer.get(reviewer);
  if (q === undefined) return;
  const i = q.indexOf(changeId);
  if (i >= 0) q.splice(i, 1);
}

// --- Submission entry point ------------------------------------------------
//
// Called from the POST /proposals route handler inside the write lock.
// Returns ok+proposal on success (which is also committed into the
// stores) or ok:false+failure on any validation or precondition error;
// in the failure case nothing is committed.

export function submitProposal(
  proposer: string,
  body: unknown,
): ParseResult {
  // 1) Top-level body envelope.
  const env = parseBodyEnvelope(body);
  if (!env.ok) return { ok: false, failure: env.failure };
  const { targetRootId, topTaxonId, payloadRaw } = env;

  // 2) Validate targetRootId (decision #5: 404 if unknown, 409 if not root).
  const rootTaxon = getTaxon(targetRootId);
  if (rootTaxon === undefined) {
    return notFound(`no such taxon (targetRootId): ${targetRootId}`);
  }
  const state = getState();
  const rootParents = state.parentsOf.get(targetRootId);
  if (rootParents !== undefined && rootParents.size > 0) {
    return conflict(
      `targetRootId ${targetRootId} is not a root (it has parents)`,
      { kind: "not_a_root", taxonId: targetRootId },
    );
  }

  // 3) Parse the payload tree (schema-only; doesn't touch live state).
  const payloadParsed = parsePayloadNode(payloadRaw, /*isTop=*/ true);
  if (!payloadParsed.ok) return { ok: false, failure: payloadParsed.failure };
  const payload = payloadParsed.node;

  // 4) Top-taxon constraints (§9.2).
  if (payload.id !== topTaxonId) {
    return validationError(
      `payload.id (${payload.id ?? "null"}) must equal topTaxonId (${topTaxonId})`,
    );
  }
  // (Top op = no-op | rename is enforced by parsePayloadNode's isTop branch.)

  // 5) Existence check for every payload id that names an existing taxon
  //    (decision #3). Also catches the top-taxon-unknown case.
  const existenceCheck = checkAllIdsExist(payload, state);
  if (!existenceCheck.ok) {
    return { ok: false, failure: existenceCheck.failure };
  }

  // 6) Top taxon must be reachable from targetRootId (§9.2).
  if (!isInTree(topTaxonId, targetRootId, state)) {
    return conflict(
      `topTaxonId ${topTaxonId} is not present in target tree (root ${targetRootId})`,
      { kind: "top_not_in_tree", taxonId: topTaxonId, rootId: targetRootId },
    );
  }

  // 7) Derive changes + dispositions + reviewers.
  const proposalId = nextProposalId();
  const changes = new Map<ChangeId, Change>();
  const nodesByInternalId = new Map<InternalNodeId, PayloadNode>();
  const queuedReviewers: { reviewer: string; changeId: ChangeId }[] = [];
  deriveChanges(
    payload,
    /*payloadPath=*/ [],
    /*nearestAddAncestorChangeId=*/ null,
    /*payloadParentTaxonId=*/ undefined,
    proposalId,
    targetRootId,
    state,
    changes,
    nodesByInternalId,
    queuedReviewers,
  );

  // 8) Commit.
  const proposal: Proposal = {
    id: proposalId,
    proposer,
    targetRootId,
    topTaxonId,
    payload,
    changes,
    nodesByInternalId,
  };
  proposals.set(proposalId, proposal);
  for (const c of changes.values()) {
    changeIndex.set(c.id, c);
  }
  for (const { reviewer, changeId } of queuedReviewers) {
    let q = queuesByReviewer.get(reviewer);
    if (q === undefined) {
      q = [];
      queuesByReviewer.set(reviewer, q);
    }
    q.push(changeId);
  }

  return { ok: true, proposal };
}

// --- Body envelope ---------------------------------------------------------

interface BodyEnvelopeOk {
  ok: true;
  targetRootId: TaxonId;
  topTaxonId: TaxonId;
  payloadRaw: Record<string, unknown>;
}
type BodyEnvelopeResult =
  | BodyEnvelopeOk
  | { ok: false; failure: ParseFailure };

function parseBodyEnvelope(body: unknown): BodyEnvelopeResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return failEnv("request body must be a JSON object");
  }
  const obj = body as Record<string, unknown>;

  const targetRootId = obj.targetRootId;
  if (typeof targetRootId !== "string" || targetRootId.length === 0) {
    return failEnv("missing or invalid 'targetRootId' (must be a non-empty string)");
  }
  const topTaxonId = obj.topTaxonId;
  if (typeof topTaxonId !== "string" || topTaxonId.length === 0) {
    return failEnv("missing or invalid 'topTaxonId' (must be a non-empty string)");
  }
  const payloadRaw = obj.payload;
  if (
    payloadRaw === null ||
    typeof payloadRaw !== "object" ||
    Array.isArray(payloadRaw)
  ) {
    return failEnv("missing or invalid 'payload' (must be a JSON object)");
  }

  return {
    ok: true,
    targetRootId,
    topTaxonId,
    payloadRaw: payloadRaw as Record<string, unknown>,
  };
}

function failEnv(message: string): BodyEnvelopeResult {
  return { ok: false, failure: { kind: "validation_error", message } };
}

// --- Payload-node parsing (§9.1) ------------------------------------------

type PayloadParseResult =
  | { ok: true; node: PayloadNode }
  | { ok: false; failure: ParseFailure };

function parsePayloadNode(raw: unknown, isTop: boolean): PayloadParseResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return failPayload("payload node must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const op = obj.op;
  if (op !== "no-op" && op !== "rename" && op !== "add" && op !== "detach") {
    return failPayload(
      `payload node 'op' must be one of "no-op" | "rename" | "add" | "detach" (got ${describeValue(op)})`,
    );
  }
  if (isTop && op !== "no-op" && op !== "rename") {
    return failPayload(`top payload taxon must be 'no-op' or 'rename' (got '${op}')`);
  }

  // Per-op field rules (§9.1 table).
  let id: TaxonId | null;
  let name: string | undefined;

  switch (op) {
    case "no-op": {
      if (typeof obj.id !== "string" || obj.id.length === 0) {
        return failPayload("'no-op' requires a non-empty string 'id'");
      }
      id = obj.id;
      // name ignored.
      break;
    }
    case "rename": {
      if (typeof obj.id !== "string" || obj.id.length === 0) {
        return failPayload("'rename' requires a non-empty string 'id'");
      }
      id = obj.id;
      const v = validateTaxonName(obj.name);
      if (!v.ok) return failPayload(`'rename' name: ${v.reason}`);
      name = v.value;
      break;
    }
    case "add": {
      // id required; may be null (create) or string (graft). A missing key
      // is NOT null (initial-plan decision #14 / §9.1 table).
      if (!Object.prototype.hasOwnProperty.call(obj, "id")) {
        return failPayload("'add' requires 'id' (string or null)");
      }
      const rawId = obj.id;
      if (rawId === null) {
        id = null;
        const v = validateTaxonName(obj.name);
        if (!v.ok) return failPayload(`'add' (create) name: ${v.reason}`);
        name = v.value;
      } else if (typeof rawId === "string" && rawId.length > 0) {
        id = rawId;
        // name ignored on graft.
      } else {
        return failPayload(
          `'add' id must be null (create) or a non-empty string (graft) (got ${describeValue(rawId)})`,
        );
      }
      break;
    }
    case "detach": {
      if (typeof obj.id !== "string" || obj.id.length === 0) {
        return failPayload("'detach' requires a non-empty string 'id'");
      }
      id = obj.id;
      // name ignored.
      break;
    }
  }

  // Children: optional, must be an array if present. detach forbids
  // children (leaf rule, §9.1).
  let children: PayloadNode[] = [];
  if (Object.prototype.hasOwnProperty.call(obj, "children")) {
    const rawChildren = obj.children;
    if (!Array.isArray(rawChildren)) {
      return failPayload("'children' must be an array if present");
    }
    if (op === "detach" && rawChildren.length > 0) {
      return failPayload("'detach' must be a leaf (no children allowed, §9.1)");
    }
    for (const child of rawChildren) {
      const r = parsePayloadNode(child, /*isTop=*/ false);
      if (!r.ok) return r;
      children.push(r.node);
    }
  } else if (op === "detach") {
    // Absent children is fine for detach; leaf rule is satisfied.
  }

  const internalId = nextInternalNodeId();
  // changeId is assigned in deriveChanges (operative nodes only).
  const node: PayloadNode = {
    internalId,
    op,
    id,
    name,
    children,
  };
  return { ok: true, node };
}

function failPayload(message: string): PayloadParseResult {
  return { ok: false, failure: { kind: "validation_error", message } };
}

// --- Existence check (decision #3) -----------------------------------------

function checkAllIdsExist(
  node: PayloadNode,
  state: TaxonState,
): { ok: true } | { ok: false; failure: ParseFailure } {
  // Add-create has id: null; nothing to check at this node. Every other op
  // names an existing taxon by id.
  if (node.id !== null) {
    if (!state.taxa.has(node.id)) {
      return {
        ok: false,
        failure: {
          kind: "not_found",
          message: `no such taxon (payload id): ${node.id}`,
        },
      };
    }
  }
  for (const child of node.children) {
    const r = checkAllIdsExist(child, state);
    if (!r.ok) return r;
  }
  return { ok: true };
}

// --- Tree-membership check (§9.2) ------------------------------------------

function isInTree(
  taxonId: TaxonId,
  rootId: TaxonId,
  state: TaxonState,
): boolean {
  if (taxonId === rootId) return true;
  // descendants() walks downward from rootId; it does NOT include rootId
  // itself, so the rootId equality above is required.
  const desc = descendants(rootId, state);
  return desc.includes(taxonId);
}

// --- Change derivation (§10.1, §10.2, §11.3) -------------------------------
//
// Recursive traversal of the payload tree. For each operative node, emit a
// Change with:
//   - payloadPath: ids of ancestors (top-down) plus self;
//   - hasDecisionDepAncestor: whether any STRICT ancestor on the path is
//     an `add` (create or graft);
//   - state: "queued" iff !hasDecisionDepAncestor, else "latent" (§11.3);
//   - reviewer per §10.1, for queued only.
//
// The `payloadParentTaxonId` parameter tracks the live-taxon id of the
// nearest ancestor that names an existing taxon (any op except an
// add-create with id:null). It's the routing target for `add` and
// `detach`. For nested ops directly under an add-create it's undefined,
// which is fine because every such change is latent (has the add-create
// as a decision-dep ancestor) and Phase 5 doesn't surface latent
// reviewers.

function deriveChanges(
  node: PayloadNode,
  ancestorPath: InternalNodeId[],
  nearestAddAncestorChangeId: ChangeId | null,
  payloadParentTaxonId: TaxonId | undefined,
  proposalId: ProposalId,
  targetRootId: TaxonId,
  state: TaxonState,
  changes: Map<ChangeId, Change>,
  nodesByInternalId: Map<InternalNodeId, PayloadNode>,
  queuedReviewers: { reviewer: string; changeId: ChangeId }[],
): void {
  nodesByInternalId.set(node.internalId, node);
  const pathHere = [...ancestorPath, node.internalId];
  const ancestorHasAdd = nearestAddAncestorChangeId !== null;

  if (node.op !== "no-op") {
    const changeId = nextChangeId();
    (node as { changeId?: ChangeId }).changeId = changeId;

    const isLatent = ancestorHasAdd;
    const stateField: ChangeState = isLatent ? "latent" : "queued";

    let reviewer: string | null = null;
    let taxonIdField: TaxonId | undefined;
    let nameField: string | undefined;
    let parentTaxonField: TaxonId | undefined;

    switch (node.op) {
      case "rename": {
        // §10.1: routed to owner of the renamed taxon (the id).
        // Renamed taxon is guaranteed to exist (existence check above).
        taxonIdField = node.id ?? undefined;
        nameField = node.name;
        // Even latent renames have a well-known reviewer (the renamed
        // taxon's owner) — recorded at submission. Phase 6 promotion
        // uses it as-is.
        const t = state.taxa.get(node.id as TaxonId);
        if (t !== undefined) reviewer = t.owner;
        break;
      }
      case "add": {
        // §10.1: routed to owner of payload-parent.
        parentTaxonField = payloadParentTaxonId;
        if (node.id === null) {
          // create: name is the proposed new name.
          nameField = node.name;
        } else {
          // graft: existing taxon id (the grafted taxon).
          taxonIdField = node.id;
        }
        if (payloadParentTaxonId !== undefined) {
          const p = state.taxa.get(payloadParentTaxonId);
          if (p !== undefined) reviewer = p.owner;
        }
        // Latent add whose payload-parent is an add-create:
        // payloadParentTaxonId is undefined here; the live id of the
        // newly-created parent is patched in at promotion time.
        break;
      }
      case "detach": {
        // §10.1: routed to owner of payload-parent. detach's affected
        // taxon (the detached child) is named by node.id.
        taxonIdField = node.id ?? undefined;
        parentTaxonField = payloadParentTaxonId;
        if (payloadParentTaxonId !== undefined) {
          const p = state.taxa.get(payloadParentTaxonId);
          if (p !== undefined) reviewer = p.owner;
        }
        break;
      }
    }

    const change: Change = {
      id: changeId,
      proposalId,
      op: node.op,
      payloadPath: pathHere,
      hasDecisionDepAncestor: ancestorHasAdd,
      nearestAddAncestorChangeId,
      taxonId: taxonIdField,
      name: nameField,
      payloadParentTaxonId: parentTaxonField,
      targetRootId,
      reviewer,
      state: stateField,
    };
    changes.set(changeId, change);
    if (stateField === "queued" && reviewer !== null) {
      queuedReviewers.push({ reviewer, changeId });
    }
  }

  // Recurse. The payload-parent taxon for the NEXT level is:
  //   - this node's id, if known (no-op, rename, detach, add-graft);
  //   - undefined, if this is an add-create (no live taxon to anchor on).
  // The "nearest add ancestor" updates to this node's changeId if this
  // is an add (create or graft); otherwise it propagates unchanged.
  const childNearestAdd: ChangeId | null =
    node.op === "add" ? (node.changeId as ChangeId) : nearestAddAncestorChangeId;
  const childParentTaxon: TaxonId | undefined =
    node.id !== null ? node.id : undefined;

  for (const child of node.children) {
    deriveChanges(
      child,
      pathHere,
      childNearestAdd,
      childParentTaxon,
      proposalId,
      targetRootId,
      state,
      changes,
      nodesByInternalId,
      queuedReviewers,
    );
  }
}

// --- Helpers ---------------------------------------------------------------

function describeValue(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function notFound(message: string): ParseResult {
  return { ok: false, failure: { kind: "not_found", message } };
}

function validationError(message: string): ParseResult {
  return { ok: false, failure: { kind: "validation_error", message } };
}

function conflict(
  message: string,
  details?: Record<string, unknown>,
): ParseResult {
  return { ok: false, failure: { kind: "conflict", message, details } };
}

// --- Status-view + queue-entry renderers ----------------------------------
//
// The route layer calls these when rendering POST /proposals (201),
// GET /proposals, GET /proposals/{id}, and GET /queue. Keeping the
// renderers in this module localizes the §11.5 isomorphism rule
// (decision #8 — what each status node carries) and the §15.2 queue
// entry shape (decision #11).

export interface StatusNode {
  op: Op;
  /** Always present. For add-create the id is null; for every other op
   *  it names a live taxon. */
  id: TaxonId | null;
  name?: string;
  changeId?: ChangeId;
  disposition: Disposition;
  reason?: string;
  children?: StatusNode[];
}

export function renderStatusTree(payload: PayloadNode, p: Proposal): StatusNode {
  const change = payload.op === "no-op"
    ? undefined
    : p.changes.get(payload.changeId as ChangeId);
  const node: StatusNode = {
    op: payload.op,
    id: payload.id,
    disposition: payload.op === "no-op"
      ? "structural"
      : (change?.state ?? "queued"),
  };
  if (payload.name !== undefined) node.name = payload.name;
  if (payload.op !== "no-op" && payload.changeId !== undefined) {
    node.changeId = payload.changeId;
  }
  if (change?.reason !== undefined) node.reason = change.reason;
  if (payload.children.length > 0) {
    node.children = payload.children.map((c) => renderStatusTree(c, p));
  }
  return node;
}

export interface QueueEntry {
  changeId: ChangeId;
  proposalId: ProposalId;
  op: "rename" | "add" | "detach";
  targetRootId: TaxonId;
  state: ChangeState;
  taxonId?: TaxonId;
  name?: string;
  payloadParentTaxonId?: TaxonId;
}

export function renderQueueEntry(c: Change): QueueEntry {
  const out: QueueEntry = {
    changeId: c.id,
    proposalId: c.proposalId,
    op: c.op,
    targetRootId: c.targetRootId,
    state: c.state,
  };
  if (c.taxonId !== undefined) out.taxonId = c.taxonId;
  if (c.name !== undefined) out.name = c.name;
  if (c.payloadParentTaxonId !== undefined) {
    out.payloadParentTaxonId = c.payloadParentTaxonId;
  }
  return out;
}
