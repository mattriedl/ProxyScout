'use strict';

/** Run `worker` over `items` with at most `concurrency` in flight. */
async function runPool(items, concurrency, worker) {
  let next = 0;
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          await worker(items[i], i);
        } catch {
          /* workers handle their own errors */
        }
      }
    })
  );
}

module.exports = { runPool };
