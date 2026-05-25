// User registry from PRD §4, §15.1.
//
// In-memory store of registered usernames. Comparison is case-insensitive
// (§4) but the first-registered casing is preserved as the canonical form
// returned by lookups and listings (resolved Phase-2 decision #4).
//
// All state-mutating registry operations clear/insert against this module;
// the central registerReset() seam (src/state.ts) drains it on POST /reset
// per §15.

import { registerReset } from "./state.js";

// Key: lowercased username. Value: original casing as first registered.
const byLower = new Map<string, string>();

// Preserves insertion order for GET /users — JS Map iteration is
// insertion-ordered, which is what we want.

export function clear(): void {
  byLower.clear();
}

registerReset(clear);

/** Returns the canonical (first-registered) form, or null if not registered. */
export function canonicalOf(name: string): string | null {
  return byLower.get(name.toLowerCase()) ?? null;
}

export function isRegistered(name: string): boolean {
  return byLower.has(name.toLowerCase());
}

export type RegisterResult =
  | { ok: true; canonical: string }
  | { ok: false; reason: "duplicate"; existing: string };

/**
 * Insert a new name. Returns ok with the canonical form on success, or a
 * duplicate result (including the previously-registered casing) on conflict.
 * Caller is responsible for the §4 format check before calling this.
 */
export function register(name: string): RegisterResult {
  const key = name.toLowerCase();
  const existing = byLower.get(key);
  if (existing !== undefined) {
    return { ok: false, reason: "duplicate", existing };
  }
  byLower.set(key, name);
  return { ok: true, canonical: name };
}

/** All registered usernames in registration order (canonical casing). */
export function list(): string[] {
  return Array.from(byLower.values());
}
