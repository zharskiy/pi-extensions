export const flushMicrotasks = async (rounds = 5) => {
  await Array.from({ length: rounds }).reduce<Promise<void>>(
    (chain) => chain.then(() => new Promise<void>((done) => setImmediate(done))),
    Promise.resolve(),
  );
};

export const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 0));

export const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

export const waitUntil = async (check: () => boolean, timeoutMs: number, label: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  const poll = async (): Promise<void> => {
    if (check()) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    }

    await pause(250);

    return poll();
  };

  return poll();
};
