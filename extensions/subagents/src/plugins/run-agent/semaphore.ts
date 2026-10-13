type Release = () => void;

type Semaphore = { acquire(): Promise<Release> };

export const createSemaphore = (limit: () => number): Semaphore => {
  let active = 0;
  const queue: (() => void)[] = [];

  const release = () => {
    active -= 1;
    pump();
  };

  const grant = (): Release => {
    let released = false;

    active += 1;

    return () => {
      if (released) {
        return;
      }

      released = true;
      release();
    };
  };

  const pump = () => {
    if (active >= limit() || queue.length === 0) {
      return;
    }

    queue.shift()?.();
    pump();
  };

  const acquire = () =>
    new Promise<Release>((resolve) => {
      queue.push(() => resolve(grant()));
      pump();
    });

  return { acquire };
};
