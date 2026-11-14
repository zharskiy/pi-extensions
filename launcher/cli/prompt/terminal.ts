import { closeSync, openSync, writeSync } from "node:fs";
import { ReadStream, WriteStream } from "node:tty";
import type { TerminalSession, Timers, Ui, UiInput, UiOutput } from "./types.ts";

export interface TtyStreams {
  input: UiInput;
  output: UiOutput;
  close?(): void;
}

export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface ExitSource {
  on(event: "exit", listener: () => void): unknown;
  off(event: "exit", listener: () => void): unknown;
}

export interface TerminalDeps {
  stdin: UiInput;
  stderr: UiOutput;
  env: NodeJS.ProcessEnv;
  openTty?: () => TtyStreams | undefined;
  escapeCodeTimeout?: number;
  timers?: Timers;
}

export interface UiOptions {
  env: NodeJS.ProcessEnv;
  close?: () => void;
  escapeCodeTimeout?: number;
  timers?: Timers;
}

const DEFAULT_COLUMNS = 80;

const DEFAULT_ROWS = 24;

const RICH_COLUMNS = 40;

const PASTE_ON = "\x1b[?2004h";

const PASTE_OFF = "\x1b[?2004l";

const CURSOR_HIDE = "\x1b[?25l";

const CURSOR_SHOW = "\x1b[?25h";

export const realTimers: Timers = {
  now: () => Date.now(),
  every: (ms, tick) => {
    const timer = setInterval(tick, ms);

    return () => clearInterval(timer);
  },
};

const isSet = (value: string | undefined) => value !== undefined && value !== "";

const cursorControlOf = (env: NodeJS.ProcessEnv) => isSet(env.TERM) && env.TERM !== "dumb";

const modeOf = (env: NodeJS.ProcessEnv, columns: number): Ui["mode"] =>
  !isSet(env.PI_SANDBOX_PLAIN) && cursorControlOf(env) && columns >= RICH_COLUMNS ? "rich" : "plain";

const UTF8 = /utf-?8/i;

const unicodeOf = (env: NodeJS.ProcessEnv) => {
  const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(isSet) ?? "";

  return UTF8.test(locale) && env.TERM !== "linux";
};

const FORCE_OFF = new Set(["0", "false"]);

const colourOf = (env: NodeJS.ProcessEnv, output: UiOutput) => {
  if (env.TERM === "dumb") {
    return false;
  }

  if (env.FORCE_COLOR !== undefined) {
    return !FORCE_OFF.has(env.FORCE_COLOR);
  }

  if (isSet(env.NO_COLOR) || isSet(env.NODE_DISABLE_COLORS)) {
    return false;
  }

  return output.isTTY === true;
};

const quietly = (action: () => void) => {
  try {
    action();
  } catch {
    return;
  }
};

const createSession = (input: UiInput, output: UiOutput, close?: () => void): TerminalSession => {
  const state = { raw: false, hidden: false, paste: false, restored: false };

  const emit = (text: string) => {
    if (typeof output.fd === "number") {
      writeSync(output.fd, text);

      return;
    }

    output.write(text);
  };

  return {
    raw: (on) => {
      if (input.isTTY !== true || input.setRawMode === undefined) {
        return;
      }

      input.setRawMode(on);

      state.raw = on;
    },
    cursor: (visible) => {
      if (state.hidden === !visible) {
        return;
      }

      emit(visible ? CURSOR_SHOW : CURSOR_HIDE);

      state.hidden = !visible;
    },
    paste: (on) => {
      if (state.paste === on) {
        return;
      }

      emit(on ? PASTE_ON : PASTE_OFF);

      state.paste = on;
    },
    restore: () => {
      if (state.restored) {
        return;
      }

      state.restored = true;

      if (state.raw || input.isRaw === true) {
        quietly(() => input.setRawMode?.(false));
      }

      if (state.paste) {
        quietly(() => emit(PASTE_OFF));
      }

      if (state.hidden) {
        quietly(() => emit(CURSOR_SHOW));
      }

      quietly(() => input.pause());

      if (close !== undefined) {
        quietly(close);
      }
    },
  };
};

export const uiOf = (streams: { input: UiInput; output: UiOutput }, options: UiOptions): Ui => {
  const { input, output } = streams;
  const columns = () => output.columns || DEFAULT_COLUMNS;

  return {
    input,
    output,
    mode: modeOf(options.env, columns()),
    cursorControl: cursorControlOf(options.env),
    unicode: unicodeOf(options.env),
    colour: colourOf(options.env, output),
    columns,
    rows: () => output.rows || DEFAULT_ROWS,
    onResize: (listener) => {
      output.on("resize", listener);

      return () => {
        output.off("resize", listener);
      };
    },
    session: createSession(input, output, options.close),
    escapeCodeTimeout: options.escapeCodeTimeout,
    timers: options.timers ?? realTimers,
  };
};

export const openDevTty = (): TtyStreams => {
  const readFd = openSync("/dev/tty", "r");

  try {
    const writeFd = openSync("/dev/tty", "w");
    const input = new ReadStream(readFd);
    const output = Object.assign(new WriteStream(writeFd), { fd: writeFd });

    return {
      input,
      output,
      close: () => {
        input.destroy();

        output.destroy();
      },
    };
  } catch (error) {
    closeSync(readFd);

    throw error;
  }
};

const openedTty = (openTty: TerminalDeps["openTty"]) => {
  try {
    return openTty?.();
  } catch {
    return undefined;
  }
};

export const findTerminal = (deps: TerminalDeps): Ui | undefined => {
  const options = { env: deps.env, escapeCodeTimeout: deps.escapeCodeTimeout, timers: deps.timers };

  if (deps.stdin.isTTY === true && deps.stderr.isTTY === true) {
    return uiOf({ input: deps.stdin, output: deps.stderr }, options);
  }

  if (isSet(deps.env.CI)) {
    return undefined;
  }

  const tty = openedTty(deps.openTty);

  return tty === undefined ? undefined : uiOf(tty, { ...options, close: tty.close });
};

export interface TerminalGuards {
  signals?: SignalSource;
  exits?: ExitSource;
  onSignal(signal: "SIGTERM" | "SIGHUP"): void;
}

export const withTerminal = async <T>(ui: Ui, guards: TerminalGuards, run: () => Promise<T>): Promise<T> => {
  const restore = () => ui.session.restore();

  const onTerm = () => {
    restore();

    guards.onSignal("SIGTERM");
  };

  const onHup = () => {
    restore();

    guards.onSignal("SIGHUP");
  };

  guards.signals?.on("SIGTERM", onTerm);

  guards.signals?.on("SIGHUP", onHup);

  guards.exits?.on("exit", restore);

  try {
    return await run();
  } finally {
    restore();

    guards.signals?.off("SIGTERM", onTerm);

    guards.signals?.off("SIGHUP", onHup);

    guards.exits?.off("exit", restore);
  }
};
