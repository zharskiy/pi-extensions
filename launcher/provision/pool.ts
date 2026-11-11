export const inPool = async <T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = [];
  const queue = items.map((item, index) => ({ item, index }));

  const worker = async (): Promise<void> => {
    const next = queue.shift();

    if (next === undefined) {
      return;
    }

    results[next.index] = await work(next.item);

    return worker();
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));

  return results;
};
