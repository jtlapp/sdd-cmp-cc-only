import { test } from "node:test";
import assert from "node:assert/strict";

import {
  taxonNamesEqual,
  validateTaxonName,
} from "../src/validation/taxonName.js";

test("validateTaxonName: accepts a single non-whitespace character", () => {
  const r = validateTaxonName("a");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, "a");
});

test("validateTaxonName: accepts a multi-word name with internal whitespace", () => {
  const r = validateTaxonName("Epic Fantasy");
  assert.equal(r.ok, true);
});

test("validateTaxonName: accepts internal tabs and newlines", () => {
  assert.equal(validateTaxonName("Epic\tFantasy").ok, true);
  assert.equal(validateTaxonName("Line1\nLine2").ok, true);
});

test("validateTaxonName: accepts hyphenated names", () => {
  assert.equal(validateTaxonName("Sword-and-Sorcery").ok, true);
});

test("validateTaxonName: accepts single-character digits and punctuation", () => {
  assert.equal(validateTaxonName("1").ok, true);
  assert.equal(validateTaxonName("?").ok, true);
});

test("validateTaxonName: rejects the empty string", () => {
  const r = validateTaxonName("");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /empty/);
});

test("validateTaxonName: rejects whitespace-only strings", () => {
  for (const s of [" ", "\t", "\n", "   "]) {
    const r = validateTaxonName(s);
    assert.equal(r.ok, false, `expected ${JSON.stringify(s)} to be rejected`);
  }
});

test("validateTaxonName: rejects leading whitespace", () => {
  const r = validateTaxonName(" Fantasy");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /begin/);
});

test("validateTaxonName: rejects trailing whitespace", () => {
  const r = validateTaxonName("Fantasy ");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /end/);
});

test("validateTaxonName: rejects leading/trailing tab and newline", () => {
  for (const s of ["\tFantasy", "Fantasy\t", "\nFantasy", "Fantasy\n"]) {
    assert.equal(validateTaxonName(s).ok, false, `expected ${JSON.stringify(s)} to be rejected`);
  }
});

test("validateTaxonName: rejects both-side whitespace", () => {
  assert.equal(validateTaxonName(" Fantasy ").ok, false);
});

test("validateTaxonName: rejects non-string inputs", () => {
  for (const v of [null, undefined, 42, {}, []]) {
    const r = validateTaxonName(v);
    assert.equal(r.ok, false, `expected ${JSON.stringify(v)} to be rejected`);
  }
});

test("taxonNamesEqual: case-insensitive equality (§3.4)", () => {
  assert.equal(taxonNamesEqual("Fantasy", "fantasy"), true);
  assert.equal(taxonNamesEqual("FANTASY", "FaNtAsY"), true);
});

test("taxonNamesEqual: distinct strings unequal", () => {
  assert.equal(taxonNamesEqual("Fantasy", "Fantasies"), false);
});

test("taxonNamesEqual: whitespace is significant for equality", () => {
  assert.equal(taxonNamesEqual("Epic Fantasy", "Epicfantasy"), false);
});
