import { test } from "node:test";
import assert from "node:assert/strict";

import { parseUsername, usernamesEqual } from "../src/validation/username.js";

test("parseUsername: undefined → null user", () => {
  assert.deepEqual(parseUsername(undefined), { kind: "null" });
});

test("parseUsername: null → null user", () => {
  assert.deepEqual(parseUsername(null), { kind: "null" });
});

test("parseUsername: empty string → null user (not malformed)", () => {
  assert.deepEqual(parseUsername(""), { kind: "null" });
});

test("parseUsername: well-formed name → valid", () => {
  const r = parseUsername("alice");
  assert.equal(r.kind, "valid");
  if (r.kind === "valid") assert.equal(r.value, "alice");
});

test("parseUsername: internal whitespace is allowed", () => {
  const r = parseUsername("Alice With Spaces Inside");
  assert.equal(r.kind, "valid");
});

test("parseUsername: leading space → malformed (not null)", () => {
  const r = parseUsername(" alice");
  assert.equal(r.kind, "malformed");
  if (r.kind === "malformed") assert.match(r.reason, /begin/);
});

test("parseUsername: trailing space → malformed", () => {
  const r = parseUsername("alice ");
  assert.equal(r.kind, "malformed");
  if (r.kind === "malformed") assert.match(r.reason, /end/);
});

test("parseUsername: both-side whitespace → malformed", () => {
  assert.equal(parseUsername(" alice ").kind, "malformed");
});

test("parseUsername: whitespace-only is malformed (not null)", () => {
  // PRD §4: malformed username is NOT silently treated as the null user.
  for (const s of [" ", "   ", "\t", "\n"]) {
    const r = parseUsername(s);
    assert.equal(r.kind, "malformed", `expected ${JSON.stringify(s)} to be malformed`);
  }
});

test("parseUsername: leading/trailing tab and newline → malformed", () => {
  for (const s of ["\talice", "alice\n"]) {
    assert.equal(parseUsername(s).kind, "malformed");
  }
});

test("usernamesEqual: case-insensitive equality (§4)", () => {
  assert.equal(usernamesEqual("alice", "ALICE"), true);
  assert.equal(usernamesEqual("Alice", "alice"), true);
});

test("usernamesEqual: distinct strings unequal", () => {
  assert.equal(usernamesEqual("alice", "alicia"), false);
});
