export const LIMIT = 64;

type Source<T> = Iterable<T> | AsyncIterable<T>;

const iteratorOf = <T>(source: Source<T>): Iterator<T> | AsyncIterator<T> =>
  Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();

export const pooled = async <T, R>(source: Source<T>, limit: number, step: (item: T) => Promise<R>) => {
  const iterator = iteratorOf(source);
  const results: R[] = [];
  let taken = 0;
  let failure: { error: unknown } | undefined;

  const work = async (): Promise<void> => {
    if (failure) {
      return;
    }

    try {
      const next = await iterator.next();

      if (next.done || failure) {
        return;
      }

      const index = taken;

      taken += 1;
      results[index] = await step(next.value);
    } catch (error) {
      failure ??= { error };
      return;
    }

    return work();
  };

  await Promise.all(Array.from({ length: limit }, work));

  if (failure) {
    await Promise.resolve(iterator.return?.()).catch(() => undefined);

    throw failure.error;
  }

  return results;
};
