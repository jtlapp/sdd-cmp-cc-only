# PRD: Collaborative Taxon Tree Server

## 1. Purpose and audience

This document specifies the requirements for a server that models shared,
multi-owner trees of **taxa** (singular: **taxon**) and mediates change
proposals between users. Each tree node is a taxon; "taxon" is used throughout
for the modeled entity, while "tree," "subtree," "root," and "DAG" retain their
ordinary graph-theoretic meaning.
It is written to be implemented by an LLM. It states **requirements and
observable behavior**, not algorithms or internal data structures. Where a
requirement constrains an outcome, the implementation is free to achieve that
outcome by any means.

The deliverable is a working server plus an automated test suite (see §13).

## 2. Technology and environment constraints

- Runtime: **Node.js**, language **TypeScript**.
- HTTP layer: **Hono**, exposing a **REST** API.
- **Toolchain and test conventions.** The accompanying toolchain supplement
  (`toolchain-supplement.md`) is **incorporated into this PRD by reference and is
  binding**. It fixes the toolchain details this section leaves open — the
  Node.js version, the module system, the build/compile model, and project
  layout — and the test mechanics referenced in §13. Consult it for any such
  detail not stated here. Where it and this PRD overlap, the supplement governs
  **toolchain and testing mechanics** and this PRD governs **domain behavior**.
- No authentication. Each request carries a possibly-null **username** (see §4).
  The server trusts that the client legitimately represents the named user.
- No user interface. Clients are out of scope; only server behavior is specified.
- **No persistence.** All state is held **in memory** and may be lost on restart.
- **User registry.** Usernames must be **registered** before use. The server
  confirms every non-null username on a request against the registry and rejects
  requests bearing an unregistered username (§4). Registration only declares that
  a name exists; it does not authenticate the caller — the no-authentication,
  trust-the-client model (above) still applies.
- Reads may be high-volume; writes are low-volume. Writes are serialized (§11.1).
- Taxon-ID generation is **implementation-defined**. IDs must be unique across the
  whole system and assigned by the server (clients never mint IDs).

## 3. Core domain model

### 3.1 Taxa

A **taxon** has:

- a unique, server-assigned **ID**,
- a **name** (a string subject to §3.4; not globally unique — see §3.4),
- an **owner** (a non-null username; never null),
- a set of **child** taxa (edges to other taxa),
- consequently, a set of **parent** taxa (the inverse of child edges).

Child taxa are **unordered** relative to one another.

### 3.2 Trees, subtrees, and the global graph

- A taxon's children may themselves have children; the structure reachable
  downward from a taxon is its **subtree**.
- A **root** is a taxon with **no parents**. A **tree** is the structure reachable
  downward from a root. A tree is identified by its root taxon's ID.
- A **subtree**'s top taxon may or may not have parents; a tree is the special
  case of a subtree whose top taxon is a root.
- A taxon may appear in **more than one tree** (it may have multiple parents whose
  ancestry leads to different roots). The global structure is therefore a
  **directed acyclic graph (DAG)**, not a forest.

### 3.3 Global invariants (must always hold)

1. **No cycles.** The graph is acyclic. No taxon may be its own ancestor.
2. **Per-tree uniqueness of occurrence.** Within any single tree (any single
   root), no taxon may be reachable by more than one path — i.e. no taxon appears
   more than once in the same tree. (Diamonds are permitted *across different*
   trees, but never *within* one.)
3. **Per-tree name uniqueness.** Within any single tree, no two distinct taxa
   may share the same name. Name comparison is **case-insensitive** (§3.4), so
   two taxa whose names differ only in case count as sharing a name.

A taxon's **name** and **owner** are global properties of the taxon, shared by
every tree the taxon appears in. Renaming a taxon changes its name in every tree
that contains it; therefore a rename must satisfy invariant (3) in **all**
containing trees, not only the tree in which the rename was proposed.

A taxon is **shared** if it is reachable from more than one root (i.e. it appears
in more than one tree).

### 3.4 Naming

A taxon name must be a **non-empty** string that **neither begins nor ends with
whitespace**. Names are compared **case-insensitively**: names differing only in
letter case are considered equal. Names need only be unique **within a tree**
(under case-insensitive comparison); the same name may appear on different taxa
in different trees. A name violating these rules (empty, or with leading/trailing
whitespace) is rejected as a validation error.

## 4. Users, identity, and visibility

- Each request carries a username via the request header **`X-Username`**. An
  absent or empty header denotes the **null user** (anonymous).
- **Username format.** A username must be a **non-empty** string that **neither
  begins nor ends with whitespace**, and is compared **case-insensitively**
  (usernames differing only in case denote the same user). A present-but-malformed
  username (e.g. whitespace-only or with leading/trailing whitespace) is rejected
  as a validation error; it is **not** silently treated as the null user.
- **Registration required.** A non-null username on a request must already be
  **registered** (§15). The server confirms it against the registry and rejects
  any request bearing an unregistered username. Registration is open (no
  authentication) but does not let the caller act as a user without naming a
  registered username.
- **Null user:** may perform **read** operations only. Any write (create, edit,
  delete, edge change, proposal submission, or review action) by the null user
  is forbidden.
- **All users (including null) can see all taxa and all proposals.** There is no
  read-level access control.
- An **owner** is always a registered, non-null username (§5, §6.2). Ownership
  may be assigned to any **registered** user; the named user need not have
  previously interacted with the system and is not consulted (see §6.2).

## 5. Ownership and rights

Every taxon has exactly one owner. The owner of a taxon holds the right to:

- **Edit** the taxon — change its **name** and/or its **owner** (§6.2).
- **Delete** the taxon, subject to the preconditions in §6.3.
- **Add** and **remove** the taxon's **child edges** directly (§6.4) — i.e. the
  owner of a *parent* controls that parent's child edges.

A user owns only the taxa they **explicitly create** (§6.1) and any taxon whose
ownership has been **assigned** to them (§6.2). Accepting another user's proposal
to create a taxon makes the **accepting owner** the owner of the new taxon, not the
proposer (§9, §12).

Users edit trees **they own** via the direct actions in §6. Users propose changes
to taxa/trees **owned by others** via the proposal mechanism in §8–§12.

## 6. Direct actions (owner-authoritative)

These are immediate, non-proposal operations available to the relevant owner.

### 6.1 Create a taxon

Any non-null, registered user (§4) may create a taxon. The created taxon:

- receives a fresh server-assigned ID,
- is owned by the creating user,
- starts as a **root** (no parents) with no children.

(To place a created taxon under a parent, use §6.4.)

### 6.2 Edit a taxon

Only the taxon's owner may edit it. Editing may change:

- **Name** — must preserve §3.3 invariant (3) in **every** tree containing the
  taxon; otherwise the edit fails as a conflict.
- **Owner** — may be reassigned to **any registered, non-null username** (§4).
  Reassignment is **unilateral**: the new owner's consent is not required and is
  not solicited. Owner may **never** be set to null or to an unregistered name.

(Reassigning ownership is the sanctioned way for an owner to stop maintaining a
taxon that others depend on — see §6.3 and §14.)

### 6.3 Delete a taxon

Only the taxon's owner may delete it. Deletion **cascades downward through the
deleter's own taxa only.** Define the **deletion region** of a delete of taxon
`N` by user `U` as: `N` itself, plus every descendant reachable from `N` by a
path passing **exclusively through taxa owned by U**. The cascade **halts upon
encountering a taxon owned by another user**: that other-owned taxon is **not**
deleted — instead the edge from its (deleted, U-owned) parent is removed, so it
**detaches** from this tree (surviving as a root if it has no other parents).
Crucially, the cascade does **not** continue past such a taxon: any
further-downstream taxa, **even those owned by U**, are **not** deleted, because
they are no longer reachable through a wholly-U-owned path. Every taxon in the
deletion region is removed permanently; every other-owned child of a deleted
taxon is detached.

Deletion is permitted **only if both** preconditions hold:

1. **No taxon in the deletion region (including `N` itself) is shared** — i.e. no
   taxon that would actually be deleted is reachable from more than one root.
   (Other-owned taxa at the halt frontier are not in the region and so may be
   shared; they are merely detached from this tree, which is non-destructive.)
2. `N` has **no parent**, **or** has exactly one parent **owned by U**.

(Given precondition 1, `N` itself is unshared and therefore has at most one
parent; precondition 2 then requires that parent, if any, to be owned by the
deleter. The two preconditions together imply a deletable taxon is either a root
or has a single same-owner parent.)

Deleting a region that contains **U-owned** shared taxa is therefore a
**multi-step, collaborative** operation: the owner must first get those shared
taxa detached from their other parents (via proposals to those parents' owners,
§8) until no taxon in the deletion region is shared, and only then delete. This
is an accepted property of the system, not a defect (§14).

### 6.4 Add or remove a child edge directly

The owner of a **parent** taxon may directly:

- **Add** an existing taxon as a child of the parent, or
- **Remove** (detach) an existing child edge from the parent.

Adding an edge must preserve all §3.3 invariants in the affected tree(s):
no cycle, no in-tree duplicate (diamond), and no in-tree name clash (taxon names
compared as exact, case-sensitive strings). An edge addition that would violate
any invariant fails as a conflict.

Removing an edge detaches the child from this parent only; the child (and its
subtree) persists, becoming a root if it has no remaining parents. Removal is
**detach**, never delete.

## 7. Distinction: detach vs. delete

- **Detach** removes a single parent→child edge. The child and its subtree
  survive. Detach is available directly to the parent's owner (§6.4) and is
  proposable to the parent's owner (§8). Detach never destroys data.
- **Delete** permanently removes a taxon and its **deletion region** (the taxon
  plus descendants reachable through wholly-owned-by-the-deleter paths; §6.3)
  from the system, halting at and detaching taxa owned by others. Delete is
  available only to the taxon's owner, is **never** proposable, and is gated by
  §6.3.

## 8. Change proposals: overview

A user (the **proposer**) proposes modifications to a tree owned wholly or partly
by others by submitting a **proposal**. A proposal targets exactly one tree,
identified by that tree's **root ID**, and anchors its edits at a **top taxon**
that must currently be present in that tree (§10.1).

A proposal **may not change ownership.** Ownership is never a proposable
attribute. (For created taxa, ownership is determined by the accepting owner;
see §9, §12.)

A proposal fans out into multiple individually-routed, individually-decided
**changes** (§9). Different changes within one proposal may be routed to
different owners and accepted/rejected independently. There is **no** notion of
accepting "the proposal as a whole"; the unit of decision is the individual
change (or a cascade of the reviewer's own changes, §12.2).

## 9. The proposal payload

### 9.1 Shape

The proposal payload is a **tree** of payload taxa. Each payload taxon carries an
**operation** annotation plus the fields that operation requires. Because a taxon
may appear in many trees and the payload need not restate untouched regions, the
payload is **partial**: a payload taxon asserts something about itself and about
the children explicitly listed beneath it, and asserts **nothing** about any
unlisted children of the corresponding live taxon.

The four operations are:

| Op       | `id`            | `name`        | May have nested children? | Meaning |
|----------|-----------------|---------------|----------------------------|---------|
| `no-op`  | required        | ignored       | yes                        | Structural anchor: asserts this taxon exists at this position; carries nested ops. Produces no change. |
| `rename` | required        | required (new)| yes                        | Change the named taxon's name; also anchors nested ops. |
| `add`    | null **or** existing ID | required if `id` is null; ignored if `id` is given | yes | Add a child edge under the payload-parent. `id: null` ⇒ **create** a new taxon; existing `id` ⇒ **graft** an existing taxon (and its live subtree). |
| `detach` | required        | ignored       | no (must be a leaf)        | Remove the edge from the payload-parent to this taxon. |

### 9.2 Top taxon

The payload's top taxon must be `no-op` or `rename` (you cannot `add` or `detach`
the anchor itself). Its `id` must identify a taxon that is **currently present in
the target tree** (reachable from the target root). The top taxon need not be the
tree's root — a proposal may anchor at any in-tree taxon and thus target a
subtree.

### 9.3 Create vs. graft (both are `add`)

- **Create** (`id: null`, `name` required): proposes a brand-new taxon as a child
  of the payload-parent. On acceptance the **accepting owner** becomes the new
  taxon's owner. A create taxon may carry nested ops (e.g. nested creates), which
  depend on the create being accepted first (§10).
- **Graft** (existing `id`, `name` ignored): proposes adding an existing taxon
  (which the proposer need **not** own, and which may be **any** taxon anywhere)
  as a child of the payload-parent. The grafted taxon brings its existing live
  subtree implicitly. A graft taxon **may** carry nested ops; those nested ops are
  evaluated against the **post-graft** state (graft is applied first, then nested
  ops evaluate against the result). This supports moving taxa into or out of a
  grafted subtree.

### 9.4 Operations that are not directly representable

Re-parenting a taxon *within* a tree (a "move") is **not** a single operation. It
is expressed as a `detach` (from the old parent) plus an `add`/graft (under the
new parent). Across different trees, these are two separate proposals (different
target roots). Moves are therefore **non-atomic** (§14).

## 10. Routing and dependencies

### 10.1 Routing (who reviews each change)

Each operative payload taxon produces a **change** routed to a single **reviewer**:

- `rename` → routed to the **owner of the renamed taxon** (the taxon named by `id`).
- `detach` → routed to the **owner of the payload-parent** (the holder of the
  "remove child edges" right), even though the `detach` annotation sits on the
  child taxon.
- `add` (create or graft) → routed to the **owner of the payload-parent** (the
  anchor under which the child is added).
- `no-op` → produces **no change** and is routed to no one; it serves only as a
  structural anchor/precondition for its descendants.

(Consequently, for the same payload taxon, a `rename` routes to the taxon's owner
while operations *nested beneath* it route to that taxon's owner only insofar as
that taxon is their parent — different operations may route to different owners.)

### 10.2 Dependency rules

A change's **payload path** is the chain of payload taxa from the top taxon down
to (and including) the change's taxon. Along that path:

- Each ancestor that is an `add` (create or graft) is a **decision dependency**:
  it must have been **accepted** before the descendant can become available.
- Each ancestor that is `no-op` or `rename` is an **existence dependency**: the
  corresponding taxon must **currently exist at that position** in the target tree
  for the descendant to be valid. (A *pending* rename does not block a
  descendant; the descendant depends only on the taxon's existence, which a rename
  does not disturb.)

The top taxon itself is an existence dependency (it must remain present in the
target tree).

### 10.3 Validation scope

All acceptance-time validation is performed against the **full containing
tree(s)**, regardless of how shallow or deep the payload anchor sits. A change
nested deep in the payload is still checked against every §3.3 invariant across
the entire tree rooted at the target root — and, for renames and grafts, across
**every other tree** the affected taxon belongs to.

## 11. Proposal lifecycle

### 11.1 Concurrency

All state-mutating operations (direct actions and review actions) are
**serialized**: each completes atomically before the next begins. Reads need not
be synchronized. Implementations may achieve this with a single global write
lock or equivalent. This is acceptable because writes are low-volume.

### 11.2 Change states

A change moves through these observable states:

- **latent** — submitted but not yet available to its reviewer because one or
  more decision dependencies (§10.2) are not yet accepted. Latent changes are
  **not** in any reviewer's queue.
- **queued** — all decision dependencies are accepted; the change is in its
  reviewer's actionable queue, awaiting an accept/reject decision.
- **accepted** — the change has been accepted by its reviewer and applied to
  live state.
- **rejected** — the change has been rejected by its reviewer.
- **invalid** — the change can no longer be applied (see §11.4). Invalid changes
  are removed from the actionable queue (dequeued).

### 11.3 Queue-after-dependencies

A change is queued to its reviewer **only after** its decision dependencies
(§10.2) are accepted. Therefore:

- At submission, only changes with no `add`/graft ancestor on their path queue
  immediately.
- Accepting an `add`/graft change **promotes** its direct dependents from
  *latent* to *queued* (routing each to its reviewer), provided their existence
  dependencies also currently hold.
- Reviewers never see changes they cannot yet act upon.

### 11.4 Invalidation and dequeuing

A change becomes **invalid** and is dequeued in any of these cases:

1. **Dependency failure.** An `add`/graft ancestor on the change's path was
   **rejected** or became **invalid**. All of that ancestor's payload
   descendants become invalid (they can never satisfy their dependencies). Such
   changes were latent (never queued), so no reviewer action is involved.
2. **Self-invalidation by the reviewer.** A reviewer's own action (accepting,
   cascade-accepting, or rejecting one of their queued changes) causes **another
   of that same reviewer's queued changes** to no longer validate. The affected
   change is **automatically dismissed** (invalidated and dequeued) with no
   action required from the reviewer.
3. **External invalidation.** Any **other** action (a direct edit/delete/edge
   change, or acceptance of a **different** proposal by a **different** owner)
   causes a change currently queued to a reviewer to no longer validate. The
   change is marked **invalid** but **remains in the reviewer's queue** until the
   reviewer explicitly **dismisses** it (§12.4).

Validity is evaluated **lazily** — when a reviewer reads their queue or attempts
an action — rather than eagerly recomputed on every unrelated state change.

The proposer's status view (§11.5) shows only the state **`invalid`** in all of
the above cases; it does not distinguish auto-dismissed from
awaiting-dismissal, nor the cause.

### 11.5 Proposer notifications (pull)

Notifications are **pulled**, not pushed. The proposer retrieves the status of a
submitted proposal as a structure **isomorphic to the submitted payload tree**,
where each taxon additionally carries a **disposition** = its current state (one
of: latent, queued, accepted, rejected, invalid) and, for negative states
(rejected/invalid), an optional human-readable **reason**. `no-op` taxa carry a
disposition indicating they are structural and produce no change.

This view reflects every accept / reject / invalidation event and is the
mechanism by which the proposer learns the outcome of each change.

## 12. Review actions

A reviewer acts only on changes **currently queued to them**.

### 12.1 Accept a single change

Accept one queued change. The server validates it against current live state
(§10.3); if valid it is applied atomically, its state becomes **accepted**, and
its direct dependents are promoted (§11.3). If it is no longer valid, the
acceptance fails with a reason; the change transitions per §11.4 (self- vs
external-invalidation).

When an `add`-create change is accepted, the **accepting reviewer becomes the
owner** of the newly created taxon.

### 12.2 Accept a cascade (atomic)

Accept, rooted at one of the reviewer's queued changes, a **maximal recursive
set** of changes that the reviewer is able to accept within that subtree:

- Accept the rooted change; its acceptance promotes dependents; any newly-queued
  dependent **also routed to this same reviewer** is accepted too; recurse.
- The cascade is bounded by changes routed to **other** owners (which it cannot
  accept) and by leaves.
- Application proceeds in payload-topological order (parents before children).

The cascade is **atomic**: it either completes in its entirety or, if **any**
constituent acceptance fails validation, the **entire cascade rolls back** to the
state before the call, leaving every change in the cascade unchanged, and returns
a **reason** identifying the failure.

Because cascade validation is sequential against evolving state, a change may
validate differently inside a cascade than as a standalone single accept; this
non-equivalence is intended.

### 12.3 Reject a change

Reject one queued change. Its state becomes **rejected**. All of its payload
descendants become **invalid** (§11.4 case 1).

### 12.4 Dismiss an invalid change

Dismiss a change that is in the reviewer's queue in the **invalid** state due to
**external** invalidation (§11.4 case 3). Dismissal removes it from the queue.
Dismiss applies only to externally-invalidated queued changes;
self-invalidated changes (case 2) are auto-dismissed and require no action;
dependency-failed changes (case 1) were never queued.

## 13. Testing requirements

The implementation must include an automated test suite covering:

- **Primary/happy paths** — normal create/edit/delete/edge operations, normal
  proposal submission, routing, queuing-after-dependencies, single and cascade
  acceptance, rejection, and the resulting tree state.
- **Edge cases** — multi-tree shared taxa, grafts with nested ops, partial
  payloads, cascade frontiers that expand across acceptances, renames affecting
  multiple trees, deletion preconditions at their boundaries, and ownership
  reassignment.
- **Failure / error scenarios** — invariant violations (cycle, in-tree duplicate,
  in-tree name clash), forbidden actions (null-user writes, non-owner actions),
  not-found references, dependency failures cascading to invalidation, external
  invalidation requiring dismissal, self-invalidation auto-dismissal, and
  atomic-cascade rollback on mid-cascade failure.

Tests should use taxa representing **genres of fiction** (e.g. "Epic Fantasy,"
"Psychological Thriller," "Space Opera") rather than real-world scientific or
organizational categories. A sample fiction-genre taxonomy (`sample-taxonomy.md`)
is provided as a **non-normative** source of realistic names and a suggestive
hierarchy; tests may draw names from it, rearrange them, extend it, or fabricate
others as needed. No taxonomy used in tests need match any published
classification.

The sample taxonomy is **inspiration only** — a pool of names. It carries no
owners, IDs, or live structure, and the system builds nothing from it directly.
The trees the product operates on are created dynamically by operations, so tests
must **construct and vary that structure themselves**: multiple roots and trees,
shared taxa and DAG shapes, multi-owner ownership and routing, grafts, and the
deliberate invariant violations (cycle, in-tree duplicate, and in-tree name clash,
including case-variant clashes per §3.4). Draw names from the taxonomy where
convenient; assign owners, and let the server assign IDs.

The test framework, file layout, and run commands are fixed by the toolchain
supplement (incorporated by reference, §2): tests use the built-in `node:test`
runner with `node:assert/strict`, and no third-party test framework is permitted.
This section governs **what behavior** the suite must cover; the supplement
governs **how** tests are written and run. The per-phase initial and final
test-plan artifacts (with changelog) required by the implementation briefs are
likewise binding. Tests that exercise server state must isolate it via the reset
endpoint (§15) before each test; the toolchain supplement fixes the mechanics.

Specific test scenarios are intentionally **not enumerated** here; choosing and
structuring them is part of the implementation.

## 14. Accepted properties and rationale (non-defects)

The following consequences of the model are **intentional** and must not be
"fixed" by deviating from the requirements:

- **Moves are non-atomic.** Re-parenting is a detach plus an add routed
  independently (and, across trees, in separate proposals). A move may land
  partially — e.g. a taxon attached under its new parent but not yet detached from
  the old (temporarily shared), or detached without being re-attached (left as a
  root). This is permitted.
- **Deletion may require collaboration.** Deleting a region containing
  **U-owned** shared taxa requires first detaching those taxa from their other
  parents via proposals that the relevant owners may decline. Deletion is thus
  not always unilaterally achievable.
- **Ownership reassignment is unilateral.** A taxon may be assigned to any
  registered user without their consent; the recipient may in turn reassign or
  (subject to §6.3) delete it.
- **Cascade deletion never removes other users' taxa.** The cascade deletes only
  the deleter's own connected region and **halts** at taxa owned by others,
  which detach (and survive) rather than being deleted. A consequence: taxa
  **further downstream** that the deleter owns are **not** deleted if they sit
  beneath an other-owned halt point, because the cascade cannot reach them
  through a wholly-owned path. Deletion therefore can leave behind detached
  subtrees and "stranded" owned taxa; this is intended.
- **Name uniqueness is enforced per-tree but names are global.** A valid rename
  in the target tree can still be blocked by a name clash in another tree the
  taxon belongs to — a tree the proposer may not be able to see the relevance of.

## 15. REST API surface

All requests carry the user via the `X-Username` header (absent/empty = null
user). All responses are JSON. The endpoint set below is normative in behavior;
exact paths may be adapted so long as the operations and semantics are preserved.

**State reset (test support).** The server exposes a single reset operation —
suggested `POST /reset` — that restores the server to the state it would have
immediately after a fresh start: it clears **all** in-memory state (taxa and
edges; proposals and their derived changes and queues; the user registry),
leaving no taxa, no proposals, and an empty registry, and resets any server-side
ID-generation state. Reset is **exempt from the §4 authorization gate**: it is
callable by any client regardless of `X-Username`, including the null and
unregistered cases. It runs under the §11.1 write serialization and returns
`204 No Content` on success (or the §15.6 error envelope on failure). Because
reset is defined as equivalent to a fresh start, every phase that introduces new
in-memory state must keep reset clearing that state. Tests use it for isolation
(§13).

### 15.1 User registry

- `POST /users` — register a username (body: `{ username }`). The username must
  satisfy the §4 format rules and must not already be registered (case-insensitive).
  Open to all (no authentication). → `201`. A duplicate registration is a
  conflict; a malformed username is a validation error.
- `GET /users` — list registered usernames (available to all, including null).

### 15.2 Reads (available to all users, including null)

- `GET /taxa` — list all taxa (id, name, owner, child IDs, parent IDs).
- `GET /taxa/{id}` — retrieve a single taxon.
- `GET /trees` — list all roots (parentless taxa), each identifying a tree.
- `GET /trees/{rootId}` — retrieve the full tree expanded from a root.
- `GET /proposals` — list proposals (optionally filterable by proposer).
- `GET /proposals/{id}` — retrieve a proposal as the payload-tree-with-dispositions
  (§11.5). Readable by anyone; this is also how a **reviewer** obtains the
  proposed change payload to build context for their decision.
- `GET /queue` — list the calling user's currently **queued** changes (across all
  proposals), including those in the **invalid–awaiting-dismiss** sub-state. Each
  entry exposes at least: change ID, proposal ID, operation, the affected
  taxon(s)/edge, and the target root.

### 15.3 Direct actions (require a non-null, registered owner)

- `POST /taxa` — create a taxon (body: `{ name }`, satisfying §3.4); caller
  becomes owner; taxon is a root. → `201`.
- `PATCH /taxa/{id}` — edit a taxon (body: `{ name?, owner? }`); owner only;
  any new `name` satisfies §3.4 and is validated for case-insensitive uniqueness
  across all containing trees; any new `owner` must be a registered, non-null
  username.
- `DELETE /taxa/{id}` — delete a taxon and its deletion region; owner only;
  cascade halts at and detaches other-owned taxa; subject to §6.3 preconditions.
- `PUT /taxa/{parentId}/children/{childId}` — add an existing child edge; parent
  owner only; validated against §3.3.
- `DELETE /taxa/{parentId}/children/{childId}` — detach a child edge; parent
  owner only.

### 15.4 Proposals (require a non-null, registered proposer)

- `POST /proposals` — submit a proposal. Body: `{ targetRootId, topTaxonId,
  payload }` where `payload` is the annotated payload tree (§9). The proposer is
  taken from `X-Username`. → `201` with the proposal ID and its initial
  status tree.

### 15.5 Review actions (require the change's reviewer)

- `POST /changes/{id}/accept` — accept a single queued change (§12.1).
- `POST /changes/{id}/accept-cascade` — accept the maximal cascade rooted at
  this queued change; each constituent acceptance that succeeds is committed
  independently, and a failure aborts only the remaining (not-yet-applied)
  changes (§12.2).
- `POST /changes/{id}/reject` — reject a queued change (§12.3).
- `POST /changes/{id}/dismiss` — dismiss an externally-invalidated queued change
  (§12.4).

### 15.6 Error model

Errors return an appropriate HTTP status and a JSON body of the form
`{ "error": { "code": <string>, "message": <string>, "details"?: <object> } }`.

Recommended status mapping:

- `400` — malformed request / payload schema violation, including a malformed
  username or taxon name per §3.4/§4 (`validation_error`).
- `403` — null-user write, request bearing an **unregistered** username, or
  action attempted by a non-owner / non-reviewer (`forbidden`).
- `404` — referenced taxon, tree, proposal, or change does not exist
  (`not_found`).
- `409` — invariant or precondition conflict: cycle, in-tree duplicate (diamond),
  in-tree name clash, delete-precondition failure, duplicate user registration,
  acceptance of a no-longer-valid change, or cascade rollback (`conflict`). The
  reason accompanies the response.

Failed validations on accept/cascade must report a **reason** sufficient to
identify the offending taxon/edge and the cause.

## Appendix A. Worked examples (non-normative)

These examples illustrate routing, dependency-gated queuing, cascades,
non-atomic moves, and invalidation. They are **non-normative**: they clarify
intended behavior but impose no requirement beyond §1–§15.

### A.1 Mixed operations with multi-owner routing and a create cascade

**Initial live state** — one tree, root `r1`:

```
r1  Fiction              (owner: Alice)
└── c1  Speculative Fiction  (owner: Alice)
    └── c2  Fantasy          (owner: Bob)
        └── c3  Epic Fantasy  (owner: Bob)
```

**Proposer:** Carol. She submits one proposal targeting tree `r1`, anchored at
the top taxon `r1`:

```json
{
  "targetRootId": "r1",
  "topNodeId": "r1",
  "payload": {
    "op": "no-op", "id": "r1",
    "children": [
      { "op": "rename", "id": "c1", "name": "Speculative and Imaginative Fiction",
        "children": [
          { "op": "no-op", "id": "c2",
            "children": [
              { "op": "rename", "id": "c3", "name": "High Fantasy" },
              { "op": "add", "id": null, "name": "Urban Fantasy",
                "children": [
                  { "op": "add", "id": null, "name": "Paranormal Romance" }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
}
```

**Changes produced, with routing and disposition at submission:**

| Change | Op | Routed to (why) | Initial state |
|--------|----|------------------|---------------|
| rename `c1` | rename | **Alice** — owner of `c1` | **queued** |
| rename `c3` | rename | **Bob** — owner of `c3` | **queued** |
| create *Urban Fantasy* | add (create) | **Bob** — owner of payload-parent `c2` | **queued** |
| create *Paranormal Romance* | add (create) | owner of *Urban Fantasy* (its payload-parent) | **latent** |

Notes on the dispositions:

- The `c1` rename and `c2` no-op are **existence** dependencies for everything
  below them, not decision dependencies — so the `c3` rename and the *Urban
  Fantasy* create **queue immediately**, even though the `c1` rename is still
  pending. A pending rename never blocks a descendant.
- *Paranormal Romance* sits under the *Urban Fantasy* **create**, a decision
  dependency, so it is **latent** until *Urban Fantasy* is accepted.

**Event timeline:**

1. **Bob cascade-accepts** rooted at the *Urban Fantasy* create. *Urban Fantasy*
   is created (Bob becomes its owner, since accepting a **create** transfers
   ownership to the accepting reviewer); this promotes *Paranormal Romance* from
   latent to queued — and because *Paranormal Romance* is also routed to Bob, the
   cascade continues and creates it too (Bob owns it). Both succeed atomically.
2. **Bob accepts** the `c3` rename → `c3` becomes "High Fantasy".
3. **Alice accepts** the `c1` rename → `c1` becomes "Speculative and Imaginative
   Fiction".

**Final live state:**

```
r1  Fiction                              (Alice)
└── c1  Speculative and Imaginative Fiction (Alice)
    └── c2  Fantasy                        (Bob)
        ├── c3  High Fantasy                (Bob)
        └── Urban Fantasy                   (Bob)   ← new
            └── Paranormal Romance          (Bob)   ← new
```

**Carol's pulled status** (isomorphic to her payload): `c1` rename → accepted;
`c3` rename → accepted; *Urban Fantasy* → accepted; *Paranormal Romance* →
accepted; `r1` and `c2` shown as structural (no change).

### A.2 Cross-tree move (two proposals), graft nesting, non-atomic outcome, and external invalidation

**Initial live state** — two trees:

```
T1:  a1  Suspense and Discovery Fiction (Dana)    T2:  b1  Genre Index   (Frank)
     └── a2  Thriller                   (Dana)         └── b2  Dark Fiction  (Frank)
         └── a3  Psychological Thriller  (Erin)
```

**Proposer:** Grace wants to move `a3` *Psychological Thriller* from under `a2`
(tree T1) to under `b2` (tree T2). A within-system move is a **detach + add**,
and because the two halves live in **different trees**, they are **two separate
proposals**.

**Proposal P1** — detach `a3` from `a2` (target tree T1):

```json
{
  "targetRootId": "a1", "topNodeId": "a1",
  "payload": {
    "op": "no-op", "id": "a1",
    "children": [
      { "op": "no-op", "id": "a2",
        "children": [ { "op": "detach", "id": "a3" } ] }
    ]
  }
}
```

**Proposal P2** — graft `a3` under `b2`, then create a child beneath the graft
(target tree T2):

```json
{
  "targetRootId": "b1", "topNodeId": "b1",
  "payload": {
    "op": "no-op", "id": "b1",
    "children": [
      { "op": "no-op", "id": "b2",
        "children": [
          { "op": "add", "id": "a3",
            "children": [ { "op": "add", "id": null, "name": "Unreliable Narrator Thriller" } ] }
        ] }
    ]
  }
}
```

**Changes, routing, and initial disposition:**

| Change | Op | Routed to (why) | Initial state |
|--------|----|------------------|---------------|
| P1: detach `a3` | detach | **Dana** — owner of payload-parent `a2` | **queued** |
| P2: graft `a3` under `b2` | add (graft) | **Frank** — owner of payload-parent `b2` | **queued** |
| P2: create *Unreliable Narrator Thriller* | add (create) | **Erin** — owner of `a3` (its payload-parent) | **latent** |

Note the nested create routes to **Erin** (owner of the grafted `a3`), a
**different** owner than the graft's reviewer **Frank** — and it is **latent**
until the graft is accepted.

**Event timeline:**

1. **Frank accepts the graft.** `a3` is now a child of both `a2` (T1) and `b2`
   (T2), so `a3` is now **shared**. Grafting does **not** transfer ownership —
   `a3` is still owned by Erin. Accepting the graft promotes *Unreliable Narrator
   Thriller* from latent to **queued** (to Erin).
2. **Dana rejects** the P1 detach. `a3` therefore stays under `a2` as well. The
   intended "move" has landed only partially: `a3` now appears in **both** trees
   rather than having moved. This non-atomic outcome is expected (§14). (P1's
   rejection does not touch P2; they are independent proposals.)
3. **Frank then directly detaches** `a3` from `b2` (a direct §6.4 edge removal,
   not a proposal). This removes `a3` from tree T2. Relative to Erin's still-queued
   *Unreliable Narrator Thriller* create, this is an **external** action by another
   user, and it destroys that change's anchoring context in T2. On Erin's next
   queue read or accept attempt, the change is found **invalid**; it **remains in
   Erin's queue** and Erin must explicitly **dismiss** it (§11.4 case 3, §12.4).

**Final live state** (back to the original shape):

```
T1:  a1  Suspense and Discovery Fiction (Dana)    T2:  b1  Genre Index   (Frank)
     └── a2  Thriller                   (Dana)         └── b2  Dark Fiction  (Frank)
         └── a3  Psychological Thriller  (Erin)
```

**Grace's pulled status:** P2 graft → accepted; P2 *Unreliable Narrator Thriller*
→ invalid; P1 detach → rejected.

This example exercises: cross-tree moves as two independent proposals; graft
preserving ownership; latent→queued promotion on graft acceptance; a nested op
under a graft routing to a different owner; a non-atomic move resulting in
sharing when one half is refused; and external invalidation requiring manual
dismissal.