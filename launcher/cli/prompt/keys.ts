import { emitKeypressEvents, type Interface } from "node:readline";
import { withoutControls } from "./style.ts";
import type { Key, Ui } from "./types.ts";

interface Keypress {
  sequence?: string;
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

type NamedKind = Exclude<Key, { text: string } | { letter: string }>["kind"];

const NAMED: Record<string, NamedKind> = {
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  home: "home",
  end: "end",
  return: "enter",
  enter: "enter",
  tab: "tab",
  backspace: "backspace",
  delete: "delete",
  space: "space",
};

const LETTER = /^[a-z]$/;

export const keyOf = (text: string | undefined, press: Keypress | undefined): Key | undefined => {
  const name = press?.name ?? "";

  if ((press?.ctrl === true && name === "w") || (press?.meta === true && name === "backspace")) {
    return { kind: "word-left-delete" };
  }

  if (press?.ctrl === true && LETTER.test(name)) {
    return { kind: "ctrl", letter: name };
  }

  if (name === "escape") {
    return { kind: "escape" };
  }

  if (press?.meta === true || (name === "tab" && press?.shift === true)) {
    return undefined;
  }

  const named = NAMED[name];

  if (named !== undefined) {
    return { kind: named };
  }

  const sequence = press?.sequence ?? text ?? "";

  return sequence !== "" && withoutControls(sequence) === sequence
    ? { kind: "text", text: sequence }
    : undefined;
};

export const isCtrl = (key: Key, letter: string) => key.kind === "ctrl" && key.letter === letter;

export interface KeyHandlers {
  key(key: Key): void;
  end(): void;
}

interface KeySource {
  queue: Key[];
  handlers: KeyHandlers | undefined;
  ended: boolean;
}

const sources = new WeakMap<Ui, KeySource>();

const hasEnded = (input: object) => "readableEnded" in input && input.readableEnded === true;

const attach = (ui: Ui): KeySource => {
  const input = ui.input;
  const source: KeySource = { queue: [], handlers: undefined, ended: hasEnded(input) };
  const paste = { open: false, text: "" };

  const deliver = (key: Key) => {
    if (ui.session.closed()) {
      return;
    }

    if (source.handlers === undefined) {
      source.queue.push(key);

      return;
    }

    source.handlers.key(key);
  };

  const onKeypress = (text: string | undefined, press: Keypress | undefined) => {
    if (press?.name === "paste-start") {
      paste.open = true;
      paste.text = "";

      return;
    }

    if (press?.name === "paste-end") {
      paste.open = false;

      deliver({ kind: "paste", text: paste.text });

      return;
    }

    if (paste.open) {
      paste.text += press?.sequence ?? text ?? "";

      return;
    }

    const key = keyOf(text, press);

    if (key !== undefined) {
      deliver(key);
    }
  };

  const onEnd = () => {
    source.ended = true;

    source.handlers?.end();
  };

  const timeout = ui.escapeCodeTimeout === undefined ? {} : { escapeCodeTimeout: ui.escapeCodeTimeout };

  emitKeypressEvents(input, timeout as unknown as Interface);

  input.on("keypress", onKeypress);

  input.on("end", onEnd);

  sources.set(ui, source);

  return source;
};

const sourceOf = (ui: Ui) => sources.get(ui) ?? attach(ui);

export const dropQueuedKeys = (ui: Ui) => {
  const source = sources.get(ui);

  if (source !== undefined) {
    source.queue.length = 0;
  }
};

const replay = (source: KeySource, handlers: KeyHandlers) => {
  if (source.handlers !== handlers) {
    return;
  }

  const key = source.queue.shift();

  if (key === undefined) {
    if (source.ended) {
      handlers.end();
    }

    return;
  }

  handlers.key(key);

  replay(source, handlers);
};

export interface KeyListener {
  replay(): void;
  detach(): void;
}

export const listenKeys = (ui: Ui, handlers: KeyHandlers): KeyListener => {
  if (ui.session.closed()) {
    return { replay: () => handlers.end(), detach: () => {} };
  }

  const source = sourceOf(ui);

  source.handlers = handlers;

  const stopResize = ui.onResize(() => handlers.key({ kind: "resize" }));

  ui.input.resume();

  return {
    replay: () => replay(source, handlers),
    detach: () => {
      if (source.handlers === handlers) {
        source.handlers = undefined;
      }

      stopResize();

      ui.input.pause();
    },
  };
};
