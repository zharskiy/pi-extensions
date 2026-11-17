import { dropQueuedKeys, isCtrl, listenKeys } from "./keys.ts";
import { elapsedOf } from "./style.ts";
import { Cancelled, type Key, type TaskSpec, type Timers, type Ui } from "./types.ts";

const HEARTBEAT_MS = 15_000;

export interface TaskView {
  update(text: string): void;
  warn(): void;
  redraw(): void;
  stop(): void;
}

const IDLE: TaskView = { update: () => {}, warn: () => {}, redraw: () => {}, stop: () => {} };

export const heartbeat = (timers: Timers, print: (line: string) => void) => {
  const started = timers.now();

  return timers.every(HEARTBEAT_MS, () => print(`  still working (${elapsedOf(timers.now() - started)})`));
};

export const warningOf = (spec: TaskSpec<unknown>) =>
  typeof spec.interruptWarning === "string" ? spec.interruptWarning : spec.interruptWarning();

export const runTask = <T>(ui: Ui, spec: TaskSpec<T>, open: () => TaskView) =>
  new Promise<T>((resolve, reject) => {
    if (ui.session.closed()) {
      reject(new Cancelled("end"));

      return;
    }

    const state = { text: "", warned: false, done: false, detach: () => {}, view: IDLE };

    const finish = (done: () => void) => {
      if (state.done) {
        return;
      }

      state.done = true;

      state.detach();

      state.view.stop();

      ui.session.raw(false);

      done();
    };

    const onKey = (key: Key) => {
      if (key.kind === "resize" || isCtrl(key, "l")) {
        state.view.redraw();

        return;
      }

      if (!isCtrl(key, "c")) {
        return;
      }

      if (spec.interruptWarning === "" || state.warned) {
        finish(() => reject(new Cancelled("interrupt")));

        return;
      }

      state.warned = true;

      state.view.warn();
    };

    const update = (text: string) => {
      if (state.done || text === state.text) {
        return;
      }

      state.text = text;

      state.view.update(text);
    };

    try {
      ui.session.raw(true);

      state.view = open();

      if (ui.input.isTTY === true) {
        dropQueuedKeys(ui);

        state.detach = listenKeys(ui, { key: onKey, end: () => undefined }).detach;
      }

      Promise.resolve()
        .then(() => spec.run(update))
        .then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error)),
        );
    } catch (error) {
      finish(() => reject(error));
    }
  });
