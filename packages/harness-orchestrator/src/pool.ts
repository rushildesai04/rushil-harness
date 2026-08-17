/**
 * Bounded-concurrency map.
 *
 * Concurrency is capped for a reason that is not CPU: parallel agent sessions
 * hit provider rate limits long before they saturate the machine, and a 429
 * storm costs more wall-clock than running fewer workers would have.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item, index);
    }
  });

  await Promise.all(runners);
  return results;
}
