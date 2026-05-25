// Username rules from PRD §4.
//
// A username must be a non-empty string that neither begins nor ends with
// whitespace, and is compared case-insensitively. An absent or empty
// X-Username header denotes the null user (anonymous). A present-but-malformed
// header is a validation error, NOT silently treated as the null user.
//
// This module surfaces the three-way distinction:
//   - null user (absent / empty header)         → caller decides read vs. write
//   - valid (well-formed string)                → caller checks registry (phase 2)
//   - malformed (whitespace problems)           → caller maps to §15.6 validation_error
//
// Registry membership and write authorization live in phase 2.

export type ParsedUsername =
  | { kind: "null" }
  | { kind: "valid"; value: string }
  | { kind: "malformed"; reason: string };

export function parseUsername(headerValue: string | null | undefined): ParsedUsername {
  if (headerValue === undefined || headerValue === null || headerValue === "") {
    return { kind: "null" };
  }
  if (/^\s/.test(headerValue)) {
    return { kind: "malformed", reason: "username must not begin with whitespace" };
  }
  if (/\s$/.test(headerValue)) {
    return { kind: "malformed", reason: "username must not end with whitespace" };
  }
  return { kind: "valid", value: headerValue };
}

export function usernamesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
