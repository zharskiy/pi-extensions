import type { FakeHost } from "../../../../core/test/helpers/fakes.ts";

export const createTurns = (host: Pick<FakeHost, "idle" | "settle">) => {
  const state = { open: 0 };

  return async <T>(work: () => Promise<T>): Promise<T> => {
    state.open += 1;
    host.idle = false;

    try {
      return await work();
    } finally {
      state.open -= 1;

      if (state.open === 0) {
        host.settle();
      }
    }
  };
};
