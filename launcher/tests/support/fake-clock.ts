export const FAKE_EPOCH = Date.UTC(2026, 0, 1);

export const createFakeClock = (start = FAKE_EPOCH) => {
  const state = { now: start };

  return {
    now: () => state.now,
    advance: (ms: number) => {
      state.now += ms;

      return state.now;
    },
    set: (ms: number) => {
      state.now = ms;
    },
  };
};
