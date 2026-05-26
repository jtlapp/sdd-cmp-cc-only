// Shared helpers for the Phase-5 test suites. Not a test file itself
// (filename intentionally lacks `.test.` so the node:test glob skips it).
// Compiled by `tsc` alongside the rest of the suite.
//
// Keeps the boilerplate of fresh-app + register + taxa-via-Phase-4-writes
// out of every proposal test file. Each helper is a thin wrapper over
// `app.request(...)` — no domain logic, no assertions beyond fixture
// sanity (registration / creation must succeed for the test setup to
// be meaningful).

import assert from "node:assert/strict";

import { createApp } from "../src/app.js";

export type App = ReturnType<typeof createApp>;

export type TaxonRecord = {
  id: string;
  name: string;
  owner: string;
  childIds: string[];
  parentIds: string[];
};

export type ErrorBody = {
  error: { code: string; message: string; details?: Record<string, unknown> };
};

export async function freshApp(): Promise<App> {
  const app = createApp();
  await app.request("/reset", { method: "POST" });
  return app;
}

export async function register(app: App, username: string): Promise<void> {
  const res = await app.request("/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  assert.equal(res.status, 201, `registering ${username} failed`);
}

export async function createTaxon(
  app: App,
  caller: string,
  name: string,
): Promise<TaxonRecord> {
  const res = await app.request("/taxa", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Username": caller,
    },
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201, `creating taxon ${name} failed`);
  return (await res.json()) as TaxonRecord;
}

export async function attach(
  app: App,
  caller: string,
  parentId: string,
  childId: string,
): Promise<void> {
  const res = await app.request(
    `/taxa/${parentId}/children/${childId}`,
    { method: "PUT", headers: { "X-Username": caller } },
  );
  assert.equal(res.status, 204, `attaching ${childId} under ${parentId} failed`);
}

export async function reassignOwner(
  app: App,
  caller: string,
  taxonId: string,
  newOwner: string,
): Promise<void> {
  const res = await app.request(`/taxa/${taxonId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Username": caller,
    },
    body: JSON.stringify({ owner: newOwner }),
  });
  assert.equal(
    res.status,
    200,
    `reassigning ${taxonId} from ${caller} to ${newOwner} failed`,
  );
}

export async function postProposal(
  app: App,
  caller: string | null,
  body: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (caller !== null) headers["X-Username"] = caller;
  return app.request("/proposals", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export async function getProposal(app: App, id: string, caller: string | null = null) {
  const headers: Record<string, string> = {};
  if (caller !== null) headers["X-Username"] = caller;
  return app.request(`/proposals/${id}`, { headers });
}

export async function listProposals(
  app: App,
  caller: string | null = null,
  proposer?: string,
) {
  const headers: Record<string, string> = {};
  if (caller !== null) headers["X-Username"] = caller;
  const qs = proposer === undefined ? "" : `?proposer=${encodeURIComponent(proposer)}`;
  return app.request(`/proposals${qs}`, { headers });
}

export async function getQueue(app: App, caller: string | null) {
  const headers: Record<string, string> = {};
  if (caller !== null) headers["X-Username"] = caller;
  return app.request("/queue", { headers });
}

export async function acceptChange(
  app: App,
  caller: string | null,
  changeId: string,
) {
  const headers: Record<string, string> = {};
  if (caller !== null) headers["X-Username"] = caller;
  return app.request(`/changes/${changeId}/accept`, {
    method: "POST",
    headers,
  });
}

export async function rejectChange(
  app: App,
  caller: string | null,
  changeId: string,
) {
  const headers: Record<string, string> = {};
  if (caller !== null) headers["X-Username"] = caller;
  return app.request(`/changes/${changeId}/reject`, {
    method: "POST",
    headers,
  });
}

/** Accepts a change and asserts 200. Returns the parsed body. */
export async function acceptOk(app: App, caller: string, changeId: string) {
  const res = await acceptChange(app, caller, changeId);
  if (res.status !== 200) {
    const text = await res.text();
    assert.fail(`accept ${changeId} as ${caller} failed (${res.status}): ${text}`);
  }
  return (await res.json()) as { changeId: string; state: "accepted" };
}

/** Rejects a change and asserts 200. */
export async function rejectOk(app: App, caller: string, changeId: string) {
  const res = await rejectChange(app, caller, changeId);
  if (res.status !== 200) {
    const text = await res.text();
    assert.fail(`reject ${changeId} as ${caller} failed (${res.status}): ${text}`);
  }
  return (await res.json()) as { changeId: string; state: "rejected" };
}

/** Submits a proposal and asserts it succeeded with 201. Returns the
 *  parsed response body. Most happy-path tests use this. */
export async function submitOk(app: App, caller: string, body: unknown) {
  const res = await postProposal(app, caller, body);
  if (res.status !== 201) {
    const text = await res.text();
    assert.fail(`submitProposal failed (${res.status}): ${text}`);
  }
  return (await res.json()) as ProposalResponse;
}

export interface StatusNode {
  op: "no-op" | "rename" | "add" | "detach";
  id: string | null;
  name?: string;
  changeId?: string;
  disposition: "latent" | "queued" | "accepted" | "rejected" | "invalid" | "structural";
  reason?: string;
  children?: StatusNode[];
}

export interface ProposalResponse {
  id: string;
  proposer: string;
  targetRootId: string;
  topTaxonId: string;
  payload: StatusNode;
}

export interface QueueEntry {
  changeId: string;
  proposalId: string;
  op: "rename" | "add" | "detach";
  targetRootId: string;
  state: "queued";
  taxonId?: string;
  name?: string;
  payloadParentTaxonId?: string;
}

/** Walks the status tree, yielding every node depth-first. */
export function walkStatusNodes(node: StatusNode): StatusNode[] {
  const out: StatusNode[] = [node];
  for (const child of node.children ?? []) {
    out.push(...walkStatusNodes(child));
  }
  return out;
}

export function findStatusByChangeId(
  root: StatusNode,
  changeId: string,
): StatusNode | undefined {
  return walkStatusNodes(root).find((n) => n.changeId === changeId);
}
