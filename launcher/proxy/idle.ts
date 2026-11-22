import { liveLaunches, withLaunchLock } from "../grants/index.ts";

export interface IdleWatchOptions {
  stateDir: string;
  intervalMs: number;
  emptyChecks: number;
  onIdle: () => Promise<void>;
}

export interface IdleWatch {
  idle: Promise<void>;
  stop(): void;
}

export const watchIdle = (options: IdleWatchOptions): IdleWatch => {
  const state: { empty: number; stopped: boolean; timer?: NodeJS.Timeout } = { empty: 0, stopped: false };

  const check = () =>
    withLaunchLock(options.stateDir, async () => {
      const launches = await liveLaunches(options.stateDir);

      state.empty = launches.length === 0 ? state.empty + 1 : 0;

      if (state.empty < options.emptyChecks) {
        return false;
      }

      await options.onIdle();

      return true;
    }).catch(() => false);

  const idle = new Promise<void>((resolve) => {
    const schedule = () => {
      if (state.stopped) {
        return;
      }

      state.timer = setTimeout(() => {
        void check().then((done) => (done ? resolve() : schedule()));
      }, options.intervalMs);
    };

    schedule();
  });

  const stop = () => {
    state.stopped = true;

    clearTimeout(state.timer);
  };

  return { idle, stop };
};
