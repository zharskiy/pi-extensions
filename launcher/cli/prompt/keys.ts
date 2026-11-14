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

const hasEnded = (input: object) => "readableEnded" in input && input.readableEnded === true;

export const listenKeys = (ui: Ui, handlers: KeyHandlers) => {
  const input = ui.input;
  const paste = { open: false, text: "" };

  const onKeypress = (text: string | undefined, press: Keypress | undefined) => {
    if (press?.name === "paste-start") {
      paste.open = true;
      paste.text = "";

      return;
    }

    if (press?.name === "paste-end") {
      paste.open = false;

      handlers.key({ kind: "paste", text: paste.text });

      return;
    }

    if (paste.open) {
      paste.text += press?.sequence ?? text ?? "";

      return;
    }

    const key = keyOf(text, press);

    if (key !== undefined) {
      handlers.key(key);
    }
  };

  const onEnd = () => handlers.end();
  const timeout = ui.escapeCodeTimeout === undefined ? {} : { escapeCodeTimeout: ui.escapeCodeTimeout };

  emitKeypressEvents(input, timeout as unknown as Interface);

  input.on("keypress", onKeypress);

  input.on("end", onEnd);

  const stopResize = ui.onResize(() => handlers.key({ kind: "resize" }));

  input.resume();

  if (hasEnded(input)) {
    queueMicrotask(onEnd);
  }

  return () => {
    input.off("keypress", onKeypress);

    input.off("end", onEnd);

    stopResize();

    input.pause();
  };
};
