// Taxon-name format rules from PRD §3.4.
//
// A name must be a non-empty string that neither begins nor ends with
// whitespace. Names are compared case-insensitively.

export type TaxonNameValidation =
  | { ok: true; value: string }
  | { ok: false; reason: string };

export function validateTaxonName(value: unknown): TaxonNameValidation {
  if (typeof value !== "string") {
    return { ok: false, reason: "name must be a string" };
  }
  if (value.length === 0) {
    return { ok: false, reason: "name must not be empty" };
  }
  if (/^\s/.test(value)) {
    return { ok: false, reason: "name must not begin with whitespace" };
  }
  if (/\s$/.test(value)) {
    return { ok: false, reason: "name must not end with whitespace" };
  }
  return { ok: true, value };
}

export function taxonNamesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
