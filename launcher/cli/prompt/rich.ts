import { completePath } from "./complete.ts";
import { createFrame, type FrameView } from "./frame.ts";
import { isCtrl, listenKeys } from "./keys.ts";
import { DIGITS, editLine, type LineState, lineOf, numberProblem } from "./line-editor.ts";
import {
  asciiOf,
  elapsedOf,
  type Glyphs,
  glyphsOf,
  type Paint,
  painterOf,
  printable,
  type Tone,
  tailOf,
  widthOf,
  withoutControls,
  wrap,
  wrapSegments,
} from "./style.ts";
import {
  BACK,
  type CancelCause,
  Cancelled,
  type Choice,
  type Collapse,
  type ConfirmSpec,
  type Detail,
  type Key,
  type KeyWords,
  type MultiSpec,
  type NotePlace,
  type NumberSpec,
  type PathSpec,
  type Prompts,
  type Reply,
  type SelectSpec,
  type TaskSpec,
  type TextSpec,
  type Ui,
} from "./types.ts";

interface Context {
  ui: Ui;
  glyphs: Glyphs;
  paint: Paint;
  fold: (text: string) => string;
}

type Step<T> =
  | { kind: "stay" }
  | { kind: "settle"; value: T }
  | { kind: "cancel"; cause: CancelCause }
  | { kind: "suspend"; run: () => Promise<void> };

interface View<T> {
  title: string;
  typing: boolean;
  frame(width: number): FrameView;
  key(key: Key): Step<T>;
  collapse(value: T): Collapse;
}

interface Parts {
  title: string;
  note?: string;
  detail: string[];
  body: string[];
  after: string[];
  hints: string[];
}

const STAY = { kind: "stay" } as const;

const END: Step<never> = { kind: "cancel", cause: "end" };

const RAIL_WIDTH = 3;

const POINTER_WIDTH = 2;

const MATCHES_SHOWN = 8;

const SPIN_MS = 100;

const SUMMARY_SHOWN = 3;

const settle = <T>(value: T): Step<T> => ({ kind: "settle", value });

const roomOf = (width: number) => Math.max(1, width - RAIL_WIDTH - 1);

const composed = (context: Context, parts: Parts) => {
  const { glyphs, paint } = context;
  const rail = paint("dim", glyphs.rail);
  const railed = (line: string) => (line === "" ? rail : `${rail}  ${line}`);
  const spacer = parts.detail.length > 0 ? [""] : [];
  const note = parts.note === undefined ? "" : `   ${paint("dim", context.fold(parts.note))}`;
  const head = `${paint("cyan", glyphs.active)}  ${context.fold(parts.title)}${note}`;
  const rest = [...parts.detail, ...spacer, ...parts.body, ...parts.after, ...spacer, ...parts.hints];

  return { lines: [head, ...rest.map(railed)], bodyRow: 1 + parts.detail.length + spacer.length };
};

const detailOf = (context: Context, detail: Detail | undefined, width: number) => {
  if (typeof detail === "function") {
    return detail(width);
  }

  return (detail ?? []).flatMap((line) => wrap(context.fold(line), roomOf(width)));
};

const hintsOf = (context: Context, segments: string[], width: number) =>
  wrapSegments(segments.map(context.fold), roomOf(width), context.glyphs.separator).map((line) =>
    context.paint("dim", line),
  );

const wordsOf = (spec: KeyWords, defaults: { enter: string; escape: string; interrupt: string | false }) => {
  const back = spec.escape ?? defaults.escape;
  const interrupt = spec.interrupt ?? defaults.interrupt;

  return [
    `enter ${spec.enter ?? defaults.enter}`,
    ...(back === false ? [] : [`esc ${back}`]),
    ...(interrupt === false ? [] : [`ctrl-c ${interrupt}`]),
  ];
};

const messageLines = (context: Context, tone: Tone, glyph: string, text: string, width: number) =>
  wrap(`${glyph} ${context.fold(text)}`, roomOf(width) - 2).map((line, index) =>
    context.paint(tone, index === 0 ? line : `  ${line}`),
  );

const errorLines = (context: Context, message: string | undefined, width: number) =>
  message === undefined ? [] : messageLines(context, "red", context.glyphs.error, message, width);

const warningLines = (context: Context, message: string | undefined, width: number) =>
  message === undefined ? [] : messageLines(context, "yellow", context.glyphs.warning, message, width);

const summaryOf = (labels: string[]) =>
  labels.length <= SUMMARY_SHOWN
    ? labels.join(", ")
    : `${labels.slice(0, SUMMARY_SHOWN).join(", ")} and ${labels.length - SUMMARY_SHOWN} more`;

const collapsedLines = (context: Context, title: string, collapse: Collapse) => {
  if (collapse === undefined) {
    return [];
  }

  const { glyphs, paint } = context;
  const shown = typeof collapse === "string" ? { title, text: collapse } : collapse;
  const rail = paint("dim", glyphs.rail);
  const text = shown.text.split("\n").map((line) => `${rail}  ${context.fold(printable(line))}`);

  return [`${paint("dim", glyphs.answered)}  ${context.fold(printable(shown.title))}`, ...text, rail];
};

const writeLines = (context: Context, lines: string[]) => {
  if (lines.length > 0) {
    context.ui.output.write(lines.map((line) => `${line}\n`).join(""));
  }
};

const runView = <T>(context: Context, view: View<T>) =>
  new Promise<Reply<T>>((resolve, reject) => {
    const { ui } = context;
    const frame = createFrame(ui, context.glyphs.ellipsis);
    const state = { done: false, detach: () => {} };

    const draw = () => frame.draw(view.frame(ui.columns()));

    const leave = () => {
      state.detach();

      frame.clear();

      ui.session.paste(false);

      ui.session.cursor(true);

      ui.session.raw(false);
    };

    const finish = (done: () => void) => {
      if (state.done) {
        return;
      }

      state.done = true;

      leave();

      done();
    };

    const fail = (error: unknown) => finish(() => reject(error));

    const settleWith = (value: T) =>
      finish(() => {
        writeLines(context, collapsedLines(context, view.title, view.collapse(value)));

        resolve(value);
      });

    const onKey = (key: Key) => {
      if (state.done) {
        return;
      }

      if (isCtrl(key, "c")) {
        fail(new Cancelled("interrupt"));

        return;
      }

      if (key.kind === "resize" || isCtrl(key, "l")) {
        draw();

        return;
      }

      if (key.kind === "escape") {
        finish(() => resolve(BACK));

        return;
      }

      try {
        apply(view.key(key));
      } catch (error) {
        fail(error);
      }
    };

    const enter = () => {
      ui.session.raw(true);

      ui.session.cursor(view.typing);

      ui.session.paste(view.typing);

      draw();

      state.detach = listenKeys(ui, { key: onKey, end: () => fail(new Cancelled("end")) });
    };

    const start = () => {
      try {
        enter();
      } catch (error) {
        fail(error);
      }
    };

    const apply = (step: Step<T>) => {
      switch (step.kind) {
        case "settle":
          settleWith(step.value);

          return;
        case "cancel":
          fail(new Cancelled(step.cause));

          return;
        case "suspend":
          leave();

          step.run().then(start, fail);

          return;
        default:
          draw();
      }
    };

    start();
  });

const choiceRows = <T>(
  context: Context,
  choices: Choice<T>[],
  mark: (choice: Choice<T>, index: number) => string,
  cursor: number,
) => {
  const { glyphs, paint, fold } = context;
  const heads = choices.map((choice, index) => `${mark(choice, index)}${fold(printable(choice.label))}`);
  const headWidth = Math.max(
    0,
    ...heads.filter((_head, index) => choices[index]?.tag !== undefined).map(widthOf),
  );

  return choices.map((choice, index) => {
    const head = heads[index] ?? "";
    const pointer = index === cursor ? paint("cyan", glyphs.pointer) : " ";

    const tag =
      choice.tag === undefined
        ? ""
        : `${" ".repeat(headWidth - widthOf(head))}   ${paint("dim", fold(printable(choice.tag)))}`;

    return `${pointer} ${head}${tag}`;
  });
};

const limitOf = (context: Context, detail: string[]) =>
  Math.max(SUMMARY_SHOWN, context.ui.rows() - 6 - (detail.length > 0 ? detail.length + 2 : 0));

const windowed = (context: Context, rows: string[], cursor: number, view: { top: number }, limit: number) => {
  if (rows.length <= limit) {
    view.top = 0;

    return rows;
  }

  const followed = cursor < view.top ? cursor : Math.max(view.top, cursor - limit + 1);
  const top = Math.min(followed, rows.length - limit);
  const below = rows.length - top - limit;
  const { glyphs, paint } = context;

  view.top = top;

  return [
    ...(top > 0 ? [paint("dim", glyphs.above(top))] : []),
    ...rows.slice(top, top + limit),
    ...(below > 0 ? [paint("dim", glyphs.below(below))] : []),
  ];
};

const moved = (cursor: number, key: Key, count: number) => {
  if (count === 0) {
    return undefined;
  }

  if (key.kind === "up" || isCtrl(key, "p")) {
    return (cursor - 1 + count) % count;
  }

  if (key.kind === "down" || isCtrl(key, "n")) {
    return (cursor + 1) % count;
  }

  if (key.kind === "home") {
    return 0;
  }

  return key.kind === "end" ? count - 1 : undefined;
};

const selectView = <T>(context: Context, spec: SelectSpec<T>): View<T> => {
  const { glyphs } = context;
  const initial = spec.choices.findIndex((choice) => choice.value === spec.initial);
  const state = { cursor: Math.max(0, initial), top: 0 };

  const mark = (_choice: Choice<T>, index: number) =>
    spec.radio === true ? `${index === state.cursor ? glyphs.radioOn : glyphs.radioOff} ` : "";

  return {
    title: spec.title,
    typing: false,
    frame: (width) => {
      const detail = detailOf(context, spec.detail, width);
      const rows = choiceRows(context, spec.choices, mark, state.cursor);
      const body = windowed(context, rows, state.cursor, state, limitOf(context, detail));
      const words = wordsOf(spec, { enter: "choose", escape: "back", interrupt: "cancel" });
      const hints = hintsOf(context, [`${glyphs.upDown} move`, ...words], width);

      return composed(context, { title: spec.title, detail, body, after: [], hints });
    },
    key: (key) => {
      const next = moved(state.cursor, key, spec.choices.length);

      if (next !== undefined) {
        state.cursor = next;

        return STAY;
      }

      const choice = spec.choices[state.cursor];

      if (key.kind === "enter" && choice !== undefined) {
        return settle(choice.value);
      }

      return isCtrl(key, "d") ? END : STAY;
    },
    collapse: (value) =>
      spec.collapsed === undefined
        ? spec.choices.find((choice) => choice.value === value)?.label
        : spec.collapsed(value),
  };
};

const multiView = <T>(context: Context, spec: MultiSpec<T>): View<T[]> => {
  const { glyphs, paint } = context;

  const state = {
    choices: [...spec.choices],
    checked: new Set(spec.checked),
    cursor: 0,
    top: 0,
    error: undefined as string | undefined,
  };

  const checkedChoices = () =>
    state.choices.filter((choice) => choice.action !== true && state.checked.has(choice.value));

  const add = (choice: Choice<T> | undefined) => {
    if (choice === undefined) {
      return;
    }

    const existing = state.choices.findIndex((known) => known.value === choice.value);
    const firstAction = state.choices.findIndex((known) => known.action === true);
    const at = firstAction < 0 ? state.choices.length : firstAction;

    if (existing < 0) {
      state.choices = [...state.choices.slice(0, at), choice, ...state.choices.slice(at)];
    }

    state.checked.add(choice.value);

    state.cursor = existing < 0 ? at : existing;
  };

  const mark = (choice: Choice<T>) => {
    if (choice.action === true) {
      return "";
    }

    return state.checked.has(choice.value) ? `${paint("cyan", glyphs.checked)} ` : `${glyphs.unchecked} `;
  };

  const enter = (choice: Choice<T>): Step<T[]> => {
    if (choice.action === true) {
      return {
        kind: "suspend",
        run: async () => add(await spec.onAction?.(choice.value)),
      };
    }

    const values = checkedChoices().map((checked) => checked.value);

    state.error = spec.validate?.(values);

    return state.error === undefined ? settle(values) : STAY;
  };

  return {
    title: spec.title,
    typing: false,
    frame: (width) => {
      const detail = detailOf(context, spec.detail, width);
      const rows = choiceRows(context, state.choices, mark, state.cursor);
      const body = windowed(context, rows, state.cursor, state, limitOf(context, detail));
      const toggles = state.choices.some((choice) => choice.action !== true);
      const words = wordsOf(spec, {
        enter: toggles ? "continue" : "choose",
        escape: "back",
        interrupt: "cancel",
      });

      const hints = hintsOf(
        context,
        [`${glyphs.upDown} move`, ...(toggles ? ["space select"] : []), ...words],
        width,
      );

      return composed(context, {
        title: spec.title,
        detail,
        body,
        after: errorLines(context, state.error, width),
        hints,
      });
    },
    key: (key) => {
      state.error = undefined;

      const next = moved(state.cursor, key, state.choices.length);

      if (next !== undefined) {
        state.cursor = next;

        return STAY;
      }

      const choice = state.choices[state.cursor];

      if (choice === undefined) {
        return isCtrl(key, "d") ? END : STAY;
      }

      if (key.kind === "space" && choice.action !== true) {
        if (!state.checked.delete(choice.value)) {
          state.checked.add(choice.value);
        }

        return STAY;
      }

      if (key.kind === "enter") {
        return enter(choice);
      }

      return isCtrl(key, "d") ? END : STAY;
    },
    collapse: (values) =>
      spec.collapsed === undefined
        ? summaryOf(checkedChoices().map((choice) => choice.label)) || "none"
        : spec.collapsed(values),
  };
};

const TOGGLES = new Set(["left", "right", "tab"]);

const confirmView = (context: Context, spec: ConfirmSpec): View<boolean> => {
  const { glyphs, paint, fold } = context;
  const state = { yes: spec.initial };
  const labelOf = (yes: boolean) => fold(yes ? spec.yes : spec.no);

  const option = (yes: boolean) =>
    `${state.yes === yes ? paint("cyan", glyphs.pointer) : " "} ${labelOf(yes)}`;

  return {
    title: spec.title,
    typing: false,
    frame: (width) => {
      const detail = detailOf(context, spec.detail, width);
      const body = [`${option(spec.initial)}   ${option(!spec.initial)}`];
      const words = wordsOf(spec, { enter: "confirm", escape: "back", interrupt: false });
      const hints = hintsOf(context, [`${glyphs.leftRight} choose`, "y/n", ...words], width);

      return composed(context, { title: spec.title, detail, body, after: [], hints });
    },
    key: (key) => {
      const letter = key.kind === "text" ? key.text.toLowerCase() : "";

      if (TOGGLES.has(key.kind) || letter === "h" || letter === "l") {
        state.yes = !state.yes;

        return STAY;
      }

      if (letter === "y" || letter === "n") {
        return settle(letter === "y");
      }

      if (key.kind === "enter") {
        return settle(state.yes);
      }

      return isCtrl(key, "d") ? END : STAY;
    },
    collapse: (value) => (spec.collapsed === undefined ? labelOf(value) : spec.collapsed(value)),
  };
};

const LINE_BREAK = /\r\n|\r|\n/;

const QUOTES = new Set(['"', "'"]);

const unquoted = (text: string) => {
  const first = text.at(0) ?? "";

  return text.length >= 2 && QUOTES.has(first) && text.at(-1) === first ? text.slice(1, -1) : text;
};

const cleanedPaste = (text: string, path: boolean) => {
  const [first = "", ...rest] = text.split(LINE_BREAK);
  const several = rest.some((line) => line.trim() !== "");
  const kept = withoutControls(first);

  return {
    text: path ? unquoted(kept.trim()).replaceAll("\\ ", " ") : kept,
    several,
  };
};

const PASTE_NOTE = "Pasted text had several lines; only the first was kept.";

const inputRow = (context: Context, line: LineState, width: number) => {
  const { glyphs, paint } = context;
  const room = Math.max(2, roomOf(width) - POINTER_WIDTH - 1);
  const chars = Array.from(line.value);
  const before = printable(chars.slice(0, line.cursor).join(""));
  const after = printable(chars.slice(line.cursor).join(""));

  const shown =
    widthOf(before) < room
      ? before
      : `${glyphs.ellipsis}${tailOf(before, room - 1 - widthOf(glyphs.ellipsis))}`;

  return {
    text: `${paint("cyan", glyphs.pointer)} ${shown}${after}`,
    column: RAIL_WIDTH + POINTER_WIDTH + widthOf(shown),
  };
};

const matchLines = (context: Context, matches: string[], width: number) => {
  const shown = matches.slice(0, MATCHES_SHOWN).map(printable);
  const hidden = matches.length - shown.length;
  const more = hidden > 0 ? [context.fold(`…and ${hidden} more`)] : [];

  return wrapSegments([...shown, ...more], roomOf(width) - 2, "   ").map((line) => `  ${line}`);
};

const textView = (context: Context, spec: TextSpec, path?: PathSpec): View<string> => {
  const state = {
    line: lineOf(spec.initial ?? ""),
    error: undefined as string | undefined,
    notice: undefined as string | undefined,
    matches: [] as string[],
    tabbed: false,
  };

  const complete = (complete: PathSpec) => {
    const completion = completePath(state.line.value, complete.home, complete.readdir);
    const unchanged = completion.value === state.line.value;

    state.matches = unchanged && state.tabbed ? completion.matches : [];
    state.tabbed = true;
    state.line = lineOf(completion.value);
  };

  const edit = (key: Key) => {
    if (key.kind !== "paste") {
      state.line = editLine(state.line, key, { segments: path !== undefined });

      return;
    }

    const pasted = cleanedPaste(key.text, path !== undefined);

    state.notice = pasted.several ? PASTE_NOTE : undefined;
    state.line = editLine(state.line, { kind: "paste", text: pasted.text });
  };

  return {
    title: spec.title,
    typing: true,
    frame: (width) => {
      const input = inputRow(context, state.line, width);
      const words = wordsOf(spec, { enter: "continue", escape: "back", interrupt: "cancel" });
      const hints = hintsOf(context, [...(path === undefined ? [] : ["tab completes"]), ...words], width);

      const after = [
        ...matchLines(context, state.matches, width),
        ...warningLines(context, state.notice, width),
        ...errorLines(context, state.error, width),
      ];

      const parts = composed(context, { title: spec.title, detail: [], body: [input.text], after, hints });

      return { lines: parts.lines, cursor: { row: parts.bodyRow, column: input.column } };
    },
    key: (key) => {
      const tabbed = state.tabbed;

      state.error = undefined;
      state.notice = undefined;
      state.matches = [];
      state.tabbed = false;

      if (key.kind === "enter") {
        state.error = spec.validate?.(state.line.value);

        return state.error === undefined ? settle(state.line.value) : STAY;
      }

      if (isCtrl(key, "d") && state.line.value === "") {
        return END;
      }

      if (key.kind === "tab") {
        if (path !== undefined) {
          state.tabbed = tabbed;

          complete(path);
        }

        return STAY;
      }

      edit(key);

      return STAY;
    },
    collapse: (value) => (spec.collapsed === undefined ? value : spec.collapsed(value)),
  };
};

const numberView = (context: Context, spec: NumberSpec): View<number> => {
  const state = {
    line: lineOf(String(spec.initial)),
    touched: false,
    error: undefined as string | undefined,
    warning: undefined as string | undefined,
    warned: undefined as number | undefined,
  };

  const stepped = (by: number) => {
    const current = DIGITS.test(state.line.value) ? Number(state.line.value) : spec.initial;

    return Math.min(spec.max, Math.max(spec.min, current + by));
  };

  const typed = (digits: string) => {
    state.line = state.touched ? editLine(state.line, { kind: "text", text: digits }) : lineOf(digits);
  };

  const submit = (): Step<number> => {
    state.error = numberProblem(spec, state.line.value);

    if (state.error !== undefined) {
      return STAY;
    }

    const value = Number(state.line.value);
    const warning = state.warned === value ? undefined : spec.warn?.(value);

    state.warning = warning;
    state.warned = warning === undefined ? undefined : value;

    return warning === undefined ? settle(value) : STAY;
  };

  const change = (key: Key) => {
    if (key.kind === "up" || key.kind === "down") {
      state.line = lineOf(String(stepped(key.kind === "up" ? spec.step : -spec.step)));

      return;
    }

    if (key.kind === "text" || key.kind === "paste") {
      const [first = ""] = key.text.split(LINE_BREAK);
      const digits = first.replaceAll(/[^0-9]/g, "");

      if (key.kind === "text" && digits !== key.text) {
        state.error = `Type a whole number, like ${spec.initial}.`;

        return;
      }

      typed(digits);

      return;
    }

    state.line = editLine(state.line, key);
  };

  return {
    title: spec.title,
    typing: true,
    frame: (width) => {
      const input = inputRow(context, state.line, width);
      const words = wordsOf(spec, { enter: "next", escape: "back", interrupt: false });
      const steps = `${context.glyphs.upDown} change by ${spec.step}`;
      const hints = hintsOf(context, [spec.hint, steps, ...words], width);
      const after = [
        ...errorLines(context, state.error, width),
        ...warningLines(context, state.warning, width),
      ];
      const parts = composed(context, {
        title: spec.title,
        note: spec.note,
        detail: [],
        body: [input.text],
        after,
        hints,
      });

      return { lines: parts.lines, cursor: { row: parts.bodyRow, column: input.column } };
    },
    key: (key) => {
      state.error = undefined;

      if (key.kind === "enter") {
        return submit();
      }

      if (isCtrl(key, "d") && state.line.value === "") {
        return END;
      }

      const before = state.line.value;

      change(key);

      state.touched = true;

      if (state.line.value !== before) {
        state.warning = undefined;
        state.warned = undefined;
      }

      return STAY;
    },
    collapse: (value) => (spec.collapsed === undefined ? String(value) : spec.collapsed(value)),
  };
};

const runTask = <T>(context: Context, spec: TaskSpec<T>) =>
  new Promise<T>((resolve, reject) => {
    const { ui, glyphs, paint, fold } = context;
    const frame = createFrame(ui, glyphs.ellipsis);
    const started = ui.timers.now();

    const state = {
      text: "",
      tick: 0,
      warned: false,
      done: false,
      stopTimer: () => {},
      detach: () => {},
    };

    const view = (width: number): FrameView => {
      const rail = paint("dim", glyphs.rail);
      const spinner = paint("cyan", glyphs.spinner[state.tick % glyphs.spinner.length] ?? "");
      const elapsed = paint("dim", elapsedOf(ui.timers.now() - started));
      const status = [spinner, ...(state.text === "" ? [] : [fold(state.text)]), elapsed].join(" ");
      const head = spec.title === "" ? [] : [`${paint("cyan", glyphs.active)}  ${fold(spec.title)}`];
      const stops = spec.interruptWarning === "" ? [] : [paint("dim", "ctrl-c stops waiting")];
      const hint = state.warned ? warningLines(context, spec.interruptWarning, width) : stops;

      return { lines: [...head, `${rail}  ${status}`, ...hint.map((line) => `${rail}  ${line}`)] };
    };

    const draw = () => {
      if (!state.done) {
        frame.draw(view(ui.columns()));
      }
    };

    const finish = (done: () => void) => {
      if (state.done) {
        return;
      }

      state.done = true;

      state.stopTimer();

      state.detach();

      frame.clear();

      ui.session.cursor(true);

      ui.session.raw(false);

      done();
    };

    const onKey = (key: Key) => {
      if (isCtrl(key, "c") && (spec.interruptWarning === "" || state.warned)) {
        finish(() => reject(new Cancelled("interrupt")));

        return;
      }

      state.warned = state.warned || isCtrl(key, "c");

      if (isCtrl(key, "c") || key.kind === "resize" || isCtrl(key, "l")) {
        draw();
      }
    };

    const update = (text: string) => {
      state.text = text;

      draw();
    };

    try {
      ui.session.raw(true);

      ui.session.cursor(false);

      draw();

      state.stopTimer = ui.timers.every(SPIN_MS, () => {
        state.tick += 1;

        draw();
      });

      state.detach = listenKeys(ui, { key: onKey, end: () => undefined });

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

const LEADS: Record<NotePlace, "header" | "answered" | "end" | undefined> = {
  rail: undefined,
  start: "header",
  step: "answered",
  end: "end",
};

const noteLines = (context: Context, lines: string[], place: NotePlace) => {
  const { glyphs, paint } = context;
  const rail = paint("dim", glyphs.rail);
  const lead = LEADS[place];

  const later = (line: string) => {
    if (place === "end") {
      return line === "" ? "" : `   ${line}`;
    }

    return line === "" ? rail : `${rail}  ${line}`;
  };

  return lines
    .map(context.fold)
    .map((line, index) =>
      index === 0 && lead !== undefined ? `${paint("dim", glyphs[lead])}  ${line}` : later(line),
    );
};

export const createRichPrompts = (ui: Ui): Prompts => {
  const context: Context = {
    ui,
    glyphs: glyphsOf(ui.unicode),
    paint: painterOf(ui.colour),
    fold: ui.unicode ? (text) => text : asciiOf,
  };

  return {
    select: (spec) => runView(context, selectView(context, spec)),
    multiselect: (spec) => runView(context, multiView(context, spec)),
    confirm: (spec) => runView(context, confirmView(context, spec)),
    text: (spec) => runView(context, textView(context, spec)),
    path: (spec) => runView(context, textView(context, spec, spec)),
    number: (spec) => runView(context, numberView(context, spec)),
    task: (spec) => runTask(context, spec),
    note: (lines, place = "rail") => writeLines(context, noteLines(context, lines, place)),
  };
};
