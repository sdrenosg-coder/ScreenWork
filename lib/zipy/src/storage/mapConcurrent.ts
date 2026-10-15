/** Bounded cloud IO. Preserve input order, and settle in-flight work on failure. */
export async function mapConcurrent<T, R>(
  values: readonly T[], action: (value: T, index: number) => Promise<R>, concurrency = 8,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0, failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (next < values.length && !failed) {
      const index = next++;
      try { result[index] = await action(values[index]!, index); }
      catch (error) { failed = true; failure = error; }
    }
  }));
  if (failed) throw failure;
  return result;
}
