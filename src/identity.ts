// Identity types shared across the auth middleware and route handlers.
//
// At the point a handler runs, the §4 identity has been resolved to one of
// these two cases. The malformed and unregistered cases short-circuit in the
// middleware with a §15.6 envelope and never reach a handler.

export type Identity =
  | { kind: "null" }
  | { kind: "registered"; username: string };

export type AppEnv = { Variables: { identity: Identity } };

export const IDENTITY_KEY = "identity" as const;
