// Central reset seam.
//
// PRD §15 defines POST /reset as restoring the server to fresh-boot state by
// clearing ALL in-memory state. Phase 1 has no domain state, but later phases
// (registry, taxa, proposals, ...) will register their cleanup here so the
// route handler doesn't grow per-phase.

type ResetFn = () => void;

const resetCallbacks: ResetFn[] = [];

export function registerReset(fn: ResetFn): void {
  resetCallbacks.push(fn);
}

export function resetAllState(): void {
  for (const fn of resetCallbacks) {
    fn();
  }
}
