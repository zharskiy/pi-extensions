import { type Completer, createInterface } from "node:readline/promises";
import { completePath } from "./complete.ts";
import { isCtrl, listenKeys } from "./keys.ts";
import { DIGITS, numberProblem } from "./line-editor.ts";
import { asciiOf, elapsedOf, printable } from "./style.ts";
import {
  BACK,
  Cancelled,
  type Choice,
  type Collapse,
  type Detail,
  type Key,
  type MultiSpec,
  type NumberSpec,
  type PathSpec,
  type Prompts,
  type Reply,
  type TaskSpec,
  type Ui,
} from "./types.ts";

type Parsed<T> = { value: T } | { error: string };

const HEARTBEAT_MS = 15_000;

const PICKS = /[\s,]+/;

const YES = new Set(["y", "yes"]);

const NO = new Set(["n", "no"]);

const tagOf = <T>(choice: Choice<T>) => (choice.tag === undefined ? "" : ` (${printable(choice.tag)})`);

const pickOf = (answer: string, count: number, fallback: number): Parsed<number> => {
  if (answer === "") {
    return { value: fallback };
  }

  const pick = Number(answer);

  return DIGITS.test(answer) && pick >= 1 && pick <= count
    ? { value: pick }
    : { error: `Type a number from 1 to ${count}.` };
};

const yesNoOf = (answer: string, fallback: boolean): Parsed<boolean> => {
  const word = answer.toLowerCase();

  if (word === "") {
    return { value: fallback };
  }

  if (YES.has(word) || NO.has(word)) {
    return { value: YES.has(word) };
  }

  return { error: "Type y or n." };
};

const pathLike = (answer: string) => answer.startsWith("/") || answer.startsWith("~");

export const createPlainPrompts = (ui: Ui): Prompts => {
  const queued: string[] = [];

  const print = (lines: string[]) => {
    ui.output.write(lines.map((line) => `${asciiOf(line)}\n`).join(""));
  };

  const detailOf = (detail: Detail | undefined) =>
    typeof detail === "function" ? detail(ui.columns()) : (detail ?? []);

  const printCollapse = (title: string, collapse: Collapse) => {
    if (collapse === undefined) {
      return;
    }

    const shown = typeof collapse === "string" ? { title, text: collapse } : collapse;

    print([`${printable(shown.title)}: ${printable(shown.text.split("\n").join(" "))}`, ""]);
  };

  const ask = (query: string, completer?: Completer) => {
    const next = queued.shift();

    if (next !== undefined) {
      return Promise.resolve(next);
    }

    return new Promise<string>((resolve, reject) => {
      const reader = createInterface({
        input: ui.input,
        output: ui.output,
        terminal: ui.cursorControl,
        historySize: 0,
        ...(completer === undefined ? {} : { completer }),
      });

      const state = { done: false };

      const finish = (done: () => void) => {
        if (state.done) {
          return;
        }

        state.done = true;

        reader.close();

        done();
      };

      reader.on("SIGINT", () => finish(() => reject(new Cancelled("interrupt"))));

      reader.on("close", () => finish(() => reject(new Cancelled("end"))));

      reader.question(asciiOf(query)).then(
        (answer) => finish(() => resolve(answer)),
        () => undefined,
      );
    });
  };

  const askUntil = async <T>(
    query: string,
    parse: (answer: string) => Parsed<T>,
    completer?: Completer,
  ): Promise<T> => {
    const parsed = parse((await ask(query, completer)).trim());

    if ("error" in parsed) {
      print([`Error: ${parsed.error}`]);

      return askUntil(query, parse, completer);
    }

    return parsed.value;
  };

  const multiselect = async <T>(spec: MultiSpec<T>): Promise<Reply<T[]>> => {
    const state = {
      choices: spec.choices.filter((choice) => choice.action !== true),
      checked: new Set(spec.checked),
    };
    const action = spec.choices.find((choice) => choice.action === true);
    const label = spec.plain?.label ?? "Choose";
    const adds = action === undefined ? "" : ", a path to add one";

    const help = spec.plain?.help ?? [
      `Type numbers to switch items on or off (like 1 3)${adds}, or press Enter to keep the selection.`,
    ];

    const list = () =>
      state.choices.map(
        (choice, index) =>
          `  ${index + 1}) ${state.checked.has(choice.value) ? "[x]" : "[ ]"} ${printable(choice.label)}${tagOf(choice)}`,
      );

    const values = () =>
      state.choices.filter((choice) => state.checked.has(choice.value)).map((choice) => choice.value);

    const add = (choice: Choice<T> | undefined) => {
      if (choice === undefined) {
        return;
      }

      if (!state.choices.some((known) => known.value === choice.value)) {
        state.choices = [...state.choices, choice];
      }

      state.checked.add(choice.value);
    };

    const toggle = (choice: Choice<T> | undefined) => {
      if (choice !== undefined && !state.checked.delete(choice.value)) {
        state.checked.add(choice.value);
      }
    };

    const picksOf = (answer: string) => {
      const picks = answer.split(PICKS);
      const count = state.choices.length;

      return picks.every((pick) => DIGITS.test(pick) && Number(pick) >= 1 && Number(pick) <= count)
        ? picks.map(Number)
        : undefined;
    };

    const round = async (): Promise<T[]> => {
      const marked = state.choices.flatMap((choice, index) =>
        state.checked.has(choice.value) ? [String(index + 1)] : [],
      );

      const answer = (await ask(`${label} [${marked.join(" ") || "none"}]: `)).trim();

      if (answer === "") {
        const problem = spec.validate?.(values());

        if (problem === undefined) {
          return values();
        }

        print([`Error: ${problem}`]);

        return round();
      }

      if (action !== undefined && pathLike(answer)) {
        queued.push(answer);

        add(await spec.onAction?.(action.value));

        queued.length = 0;

        print(list());

        return round();
      }

      const picks = picksOf(answer);

      if (picks === undefined) {
        const range = state.choices.length === 0 ? "" : `numbers from 1 to ${state.choices.length}, `;

        print([`Error: Type ${range}${action === undefined ? "" : "a path, "}or press Enter.`]);

        return round();
      }

      picks.forEach((pick) => {
        toggle(state.choices[pick - 1]);
      });

      print(list());

      return round();
    };

    print([spec.title, ...detailOf(spec.detail), ...list(), ...help]);

    const chosen = await round();
    const labels = state.choices
      .filter((choice) => state.checked.has(choice.value))
      .map((choice) => choice.label);

    printCollapse(
      spec.title,
      spec.collapsed === undefined ? labels.join(", ") || "none" : spec.collapsed(chosen),
    );

    return chosen;
  };

  const numberRound = async (spec: NumberSpec, fallback: number, warned?: number): Promise<number> => {
    const answer = (await ask(`${spec.title}, ${spec.min} to ${spec.max} [${fallback}]: `)).trim();
    const text = answer === "" ? String(fallback) : answer;
    const problem = numberProblem(spec, text);

    if (problem !== undefined) {
      print([`Error: ${problem}`]);

      return numberRound(spec, fallback, warned);
    }

    const value = Number(text);
    const warning = warned === value ? undefined : spec.warn?.(value);

    if (warning !== undefined) {
      print([`Warning: ${warning}`]);

      return numberRound(spec, value, value);
    }

    return value;
  };

  const task = <T>(spec: TaskSpec<T>) =>
    new Promise<T>((resolve, reject) => {
      const started = ui.timers.now();
      const state = { text: "", warned: false, done: false, detach: () => {} };

      const stopHeartbeat = ui.timers.every(HEARTBEAT_MS, () =>
        print([`  still working (${elapsedOf(ui.timers.now() - started)})`]),
      );

      const finish = (done: () => void) => {
        if (state.done) {
          return;
        }

        state.done = true;

        stopHeartbeat();

        state.detach();

        ui.session.raw(false);

        done();
      };

      const onKey = (key: Key) => {
        if (!isCtrl(key, "c")) {
          return;
        }

        if (spec.interruptWarning === "" || state.warned) {
          finish(() => reject(new Cancelled("interrupt")));

          return;
        }

        state.warned = true;

        print([`Warning: ${spec.interruptWarning}`]);
      };

      const update = (text: string) => {
        if (state.done || text === state.text) {
          return;
        }

        state.text = text;

        print([text]);
      };

      try {
        if (ui.input.isTTY === true) {
          ui.session.raw(true);

          state.detach = listenKeys(ui, { key: onKey, end: () => undefined });
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

  const completerOf =
    (spec: PathSpec): Completer =>
    (line) => {
      const completion = completePath(line, spec.home, spec.readdir);

      if (completion.matches.length > 0) {
        return [completion.matches, line];
      }

      return [completion.value === line ? [] : [completion.value], line];
    };

  return {
    select: async (spec) => {
      const count = spec.choices.length;
      const fallback =
        Math.max(
          0,
          spec.choices.findIndex((choice) => choice.value === spec.initial),
        ) + 1;
      const list = spec.choices.map(
        (choice, index) => `  ${index + 1}) ${printable(choice.label)}${tagOf(choice)}`,
      );

      print([spec.title, ...detailOf(spec.detail), ...list]);

      const pick = await askUntil(`Choose [${fallback}]: `, (answer) => pickOf(answer, count, fallback));
      const choice = spec.choices[pick - 1];

      if (choice === undefined) {
        return BACK;
      }

      printCollapse(spec.title, spec.collapsed === undefined ? choice.label : spec.collapsed(choice.value));

      return choice.value;
    },
    multiselect,
    confirm: async (spec) => {
      print(detailOf(spec.detail));

      const query = `${spec.title} (${spec.initial ? "Y/n" : "y/N"}): `;
      const value = await askUntil(query, (answer) => yesNoOf(answer, spec.initial));
      const label = value ? spec.yes : spec.no;

      printCollapse(spec.title, spec.collapsed === undefined ? label : spec.collapsed(value));

      return value;
    },
    text: async (spec) => {
      const fallback = spec.initial ?? "";
      const query = fallback === "" ? `${spec.title}: ` : `${spec.title} [${fallback}]: `;

      const value = await askUntil(query, (answer): Parsed<string> => {
        const chosen = answer === "" ? fallback : answer;
        const error = spec.validate?.(chosen);

        return error === undefined ? { value: chosen } : { error };
      });

      printCollapse(spec.title, spec.collapsed === undefined ? value : spec.collapsed(value));

      return value;
    },
    path: async (spec) => {
      const value = await askUntil(
        `${spec.title}: `,
        (answer): Parsed<Reply<string>> => {
          if (answer === "") {
            return { value: BACK };
          }

          const error = spec.validate?.(answer);

          return error === undefined ? { value: answer } : { error };
        },
        completerOf(spec),
      );

      if (value !== BACK) {
        printCollapse(spec.title, spec.collapsed === undefined ? value : spec.collapsed(value));
      }

      return value;
    },
    number: async (spec) => {
      const value = await numberRound(spec, spec.initial);

      printCollapse(spec.title, spec.collapsed === undefined ? String(value) : spec.collapsed(value));

      return value;
    },
    task,
    note: (lines) => print(lines),
  };
};
