const RUNS_ENV = "PI_EVAL_RUNS";

export const evalRunCount = () => Math.max(1, Math.floor(Number(process.env[RUNS_ENV] ?? "1")) || 1);

const parallelRuns = async <T>(count: number, run: (index: number) => Promise<T>) => {
  const settled = await Promise.allSettled(Array.from({ length: count }, (_, index) => run(index)));
  const failed = settled.find((result) => result.status === "rejected");

  if (failed) {
    throw failed.reason;
  }

  return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
};

const serialRuns = <T>(count: number, run: (index: number) => Promise<T>) =>
  Array.from({ length: count }, (_, index) => index).reduce<Promise<T[]>>(
    async (done, index) => [...(await done), await run(index)],
    Promise.resolve([]),
  );

export const repeatRuns = <T>(
  count: number,
  run: (index: number) => Promise<T>,
  options: { parallel?: boolean } = {},
): Promise<T[]> => (options.parallel ? parallelRuns(count, run) : serialRuns(count, run));
