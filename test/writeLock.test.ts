// PRD §11.1 — write serialization primitive (src/writeLock.ts).
//
// Pure unit tests of the queue: no HTTP. The HTTP-boundary serialization
// guarantees are covered in writeSerialization.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";

import { withWriteLock } from "../src/writeLock.js";

test("withWriteLock: two writes started in the same tick run sequentially", async () => {
  const log: string[] = [];
  // First write awaits a microtask before pushing — if the queue didn't
  // serialize, the second's push would interleave before the first's.
  const w1 = withWriteLock(async () => {
    await Promise.resolve();
    log.push("a");
  });
  const w2 = withWriteLock(() => {
    log.push("b");
  });
  await Promise.all([w1, w2]);
  assert.deepEqual(log, ["a", "b"]);
});

test("withWriteLock: a write that throws does NOT stall subsequent writes", async () => {
  const w1 = withWriteLock(() => {
    throw new Error("boom");
  });
  await assert.rejects(w1, /boom/);

  // The queue must keep running after the rejection.
  const w2 = await withWriteLock(() => 42);
  assert.equal(w2, 42);
});

test("withWriteLock: an async write holds the lock until it resolves", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const log: string[] = [];

  const slow = withWriteLock(async () => {
    log.push("slow:start");
    await gate;
    log.push("slow:end");
  });
  const fast = withWriteLock(() => {
    log.push("fast");
  });

  // Give the slow write a chance to start.
  await Promise.resolve();
  assert.deepEqual(log, ["slow:start"], "fast must NOT have run yet");

  release();
  await Promise.all([slow, fast]);
  assert.deepEqual(log, ["slow:start", "slow:end", "fast"]);
});

test("withWriteLock: many writes complete in submission order", async () => {
  const log: number[] = [];
  const promises = [];
  for (let i = 0; i < 10; i++) {
    const n = i;
    promises.push(
      withWriteLock(async () => {
        await Promise.resolve();
        log.push(n);
      }),
    );
  }
  await Promise.all(promises);
  assert.deepEqual(log, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("withWriteLock: rejection is surfaced to the caller, not swallowed", async () => {
  // The caller's promise must reject with the original error, even though
  // the queue's tracking ref swallows the rejection internally to prevent
  // poisoning subsequent writes.
  const err = new Error("from-fn");
  await assert.rejects(
    withWriteLock(() => {
      throw err;
    }),
    (e) => e === err,
  );
});
