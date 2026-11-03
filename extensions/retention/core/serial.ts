export const serial = async <T, R>(items: readonly T[], step: (item: T) => Promise<R>) => {
  const results: R[] = [];

  await items.reduce(
    (previous, item) =>
      previous.then(async () => {
        results.push(await step(item));
      }),
    Promise.resolve(),
  );

  return results;
};
