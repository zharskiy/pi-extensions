import { PassThrough, Writable } from "node:stream";
import { createPlainPrompts } from "../../../cli/prompt/plain.ts";
import { createRichPrompts } from "../../../cli/prompt/rich.ts";
import { uiOf } from "../../../cli/prompt/terminal.ts";
import type { Timers } from "../../../cli/prompt/types.ts";
import { createScreen } from "./screen.ts";

export const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  delete: "\x1b[3~",
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  space: " ",
  backspace: "\x7f",
  altBackspace: "\x1b\x7f",
  ctrlA: "\x01",
  ctrlC: "\x03",
  ctrlD: "\x04",
  ctrlE: "\x05",
  ctrlK: "\x0b",
  ctrlL: "\x0c",
  ctrlN: "\x0e",
  ctrlP: "\x10",
  ctrlU: "\x15",
  ctrlW: "\x17",
};

export const pasted = (text: string) => `\x1b[200~${text}\x1b[201~`;

export const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const UNTIL_LIMIT_MS = 2000;

export const until = async (condition: () => boolean, started = Date.now()): Promise<void> => {
  if (condition()) {
    return;
  }

  if (Date.now() - started > UNTIL_LIMIT_MS) {
    throw new Error("the awaited screen never appeared");
  }

  await pause(1);

  return until(condition, started);
};

const ESCAPE_WAIT_MS = 30;

export const fakeInput = (tty = true) => {
  const rawCalls: boolean[] = [];

  const stream = Object.assign(new PassThrough(), {
    isTTY: tty,
    isRaw: false,
    rawCalls,
    setRawMode: (raw: boolean) => {
      rawCalls.push(raw);

      stream.isRaw = raw;

      return stream;
    },
  });

  return stream;
};

export type FakeInput = ReturnType<typeof fakeInput>;

export const press = (input: FakeInput, ...keys: string[]) =>
  keys.reduce(
    (chain, key) =>
      chain.then(async () => {
        input.write(key);

        await pause(key === KEY.escape ? ESCAPE_WAIT_MS : 0);
      }),
    Promise.resolve(),
  );

export const fakeOutput = (columns = 80, rows = 24, tty = true) => {
  const chunks: string[] = [];
  const screen = createScreen(columns);

  const stream = Object.assign(
    new Writable({
      write: (chunk: Buffer | string, _encoding, done) => {
        const text = chunk.toString();

        chunks.push(text);

        screen.write(text);

        done();
      },
    }),
    {
      isTTY: tty,
      columns,
      rows,
      screen,
      text: () => chunks.join(""),
      resize: (width: number, height = stream.rows) => {
        stream.columns = width;
        stream.rows = height;

        screen.resize(width);

        stream.emit("resize");
      },
    },
  );

  return stream;
};

export const fakeTimers = () => {
  const state = { now: 0, jobs: [] as Array<{ ms: number; tick: () => void; next: number; live: boolean }> };

  const due = (until: number) =>
    state.jobs
      .filter((job) => job.live && job.next <= until)
      .sort((left, right) => left.next - right.next)
      .at(0);

  const run = (until: number) => {
    const job = due(until);

    if (job === undefined) {
      state.now = until;

      return;
    }

    state.now = job.next;
    job.next += job.ms;

    job.tick();

    run(until);
  };

  const timers: Timers = {
    now: () => state.now,
    every: (ms, tick) => {
      const job = { ms, tick, next: state.now + ms, live: true };

      state.jobs.push(job);

      return () => {
        job.live = false;
      };
    },
  };

  return {
    timers,
    advance: (ms: number) => run(state.now + ms),
    live: () => state.jobs.filter((job) => job.live).length,
  };
};

interface FakeUiOptions {
  columns?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
  timers?: Timers;
  tty?: boolean;
}

const RICH_ENV = { TERM: "xterm-256color", LANG: "en_US.UTF-8" };

export const fakeUi = (options: FakeUiOptions = {}) => {
  const input = fakeInput(options.tty ?? true);
  const output = fakeOutput(options.columns, options.rows, options.tty ?? true);
  const env = { ...RICH_ENV, ...options.env };
  const ui = uiOf({ input, output }, { env, escapeCodeTimeout: 5, timers: options.timers });

  return { input, output, ui, screen: output.screen };
};

export const richPrompts = (options: FakeUiOptions = {}) => {
  const fake = fakeUi(options);

  return { ...fake, prompts: createRichPrompts(fake.ui) };
};

export const plainPrompts = (options: FakeUiOptions = {}) => {
  const fake = fakeUi({ ...options, env: { PINATA_PLAIN: "1", ...options.env } });

  return { ...fake, prompts: createPlainPrompts(fake.ui) };
};

export const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
