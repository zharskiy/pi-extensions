export const settleAll = async <T extends readonly unknown[] | []>(
  pending: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> => {
  const results = await Promise.allSettled<readonly unknown[]>(pending);
  const failure = results.find((result) => result.status === "rejected");

  if (failure !== undefined) {
    throw failure.reason;
  }

  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as {
    -readonly [K in keyof T]: Awaited<T[K]>;
  };
};
