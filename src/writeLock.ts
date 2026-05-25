// Global write serializer from PRD §11.1.
//
// "All state-mutating operations (direct actions and review actions) are
//  serialized: each completes atomically before the next begins. Reads need
//  not be synchronized. Implementations may achieve this with a single global
//  write lock or equivalent."
//
// Implementation: a promise-chain queue. Every call to withWriteLock(fn)
// schedules fn() to run after every previously-queued fn has finished, and
// returns a promise resolving to fn's result. Rejections do NOT poison the
// queue — subsequent writes still run.
//
// Node.js is single-threaded, so the only interleaving point is across
// awaits inside fn. The mutation handlers in Phase 4 do not await between
// state read and state write, so each fn() runs to completion against a
// fixed snapshot. The queue exists to order asynchronous bookends (body
// parsing, etc.) and to give us a single integration point for future
// reviewer actions in Phase 5+.
//
// POST /reset also runs through this lock (§15: "It runs under the §11.1
// write serialization").

let tail: Promise<unknown> = Promise.resolve();

export function withWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const result = tail.then(() => fn());
  // Swallow rejection on the queue's tracking ref so a thrown error in fn
  // doesn't stall every subsequent acquirer. The caller still sees the
  // rejection through `result`.
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
