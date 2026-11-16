import { type Completer, createInterface } from "node:readline/promises";
import { completePath } from "./complete.ts";
import { DIGITS, initialIndex, numberProblem, toggle, warningFor } from "./rules.ts";
import { asciiOf, elapsedOf, printable, wrap } from "./style.ts";
import { runTask, type TaskView, warningOf } from "./task.ts";
import {
  BACK,
  Cancelled,
  type Choice,
  type Collapse,
  type Detail,
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

const PLAIN_WIDTH = 80;

const PICKS = /[\s,]+/;

const NUMBERS = /^[\d\s,]+$/;

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

export const createPlainPrompts = (ui: Ui): Prompts => {
  const typedAhead: string[] = [];

  const print = (lines: string[]) => {
    ui.output.write(lines.map((line) => `${asciiOf(line)}\n`).join(""));
  };

  const room = () => Math.min(ui.columns(), PLAIN_WIDTH) - 1;

  const detailOf = (detail: Detail | undefined) =>
    typeof detail === "function"
      ? detail(room())
      : (detail ?? []).flatMap((line) => (line === "" ? [""] : wrap(asciiOf(line), room())));

  const printCollapse = (collapse: Collapse) => {
    if (collapse !== undefined) {
      print([`${printable(collapse.title)}: ${printable(collapse.text.split("\n").join(" "))}`, ""]);
    }
  };

  const ask = (query: string, completer?: Completer) => {
    const ahead = typedAhead.shift();

    if (ahead !== undefined) {
      ui.output.write(`${asciiOf(query)}${asciiOf(printable(ahead))}\n`);

      return Promise.resolve(ahead);
    }

    if (ui.session.closed()) {
      return Promise.reject(new Cancelled("end"));
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

      reader.on("line", (line) => {
        typedAhead.push(line);
      });

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

      const answer = (await ask(`${spec.plain.label} [${marked.join(" ") || "none"}]: `)).trim();

      if (answer === "") {
        return values();
      }

      const picks = picksOf(answer);

      if (picks === undefined && action !== undefined && !NUMBERS.test(answer)) {
        add(await spec.onAction?.(action.value, answer));

        print(list());

        return round();
      }

      if (picks === undefined) {
        const range = state.choices.length === 0 ? "" : `numbers from 1 to ${state.choices.length}, `;

        print([`Error: Type ${range}or press Enter.`]);

        return round();
      }

      picks.forEach((pick) => {
        const choice = state.choices[pick - 1];

        if (choice !== undefined) {
          toggle(state.checked, choice.value);
        }
      });

      print(list());

      return round();
    };

    print([spec.title, ...detailOf(spec.detail), ...list(), ...spec.plain.help]);

    const chosen = await round();

    printCollapse(spec.collapsed(chosen));

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
    const warning = warningFor(spec, value, warned);

    if (warning !== undefined) {
      print([`Warning: ${warning}`]);

      return numberRound(spec, value, value);
    }

    return value;
  };

  const taskView = (spec: TaskSpec<unknown>) => (): TaskView => {
    const started = ui.timers.now();

    const stop = ui.timers.every(HEARTBEAT_MS, () =>
      print([`  still working (${elapsedOf(ui.timers.now() - started)})`]),
    );

    return {
      update: (text) => print([text]),
      warn: () => print([`Warning: ${warningOf(spec)}`]),
      redraw: () => undefined,
      stop,
    };
  };

  const task = <T>(spec: TaskSpec<T>) => {
    typedAhead.length = 0;

    return runTask(ui, spec, taskView(spec));
  };

  const completerOf =
    (spec: PathSpec): Completer =>
    (line) => {
      const completion = completePath(line, spec.home, spec.readdir);

      if (completion.matches.length > 0) {
        return [completion.matches, line];
      }

      return [completion.value === line ? [] : [completion.value], line];
    };

  const path = async (spec: PathSpec) => {
    const fallback = spec.initial ?? "";
    const query = fallback === "" ? `${spec.title}: ` : `${spec.title} [${fallback}]: `;

    const value = await askUntil(
      query,
      (answer): Parsed<string> => {
        const chosen = answer === "" ? fallback : answer;
        const error = spec.validate?.(chosen);

        return error === undefined ? { value: chosen } : { error };
      },
      completerOf(spec),
    );

    printCollapse(spec.collapsed(value));

    return value;
  };

  return {
    select: async (spec) => {
      const count = spec.choices.length;
      const fallback = initialIndex(spec.choices, spec.initial) + 1;
      const list = spec.choices.map(
        (choice, index) => `  ${index + 1}) ${printable(choice.label)}${tagOf(choice)}`,
      );

      print([spec.title, ...detailOf(spec.detail), ...list]);

      const pick = await askUntil(`Choose [${fallback}]: `, (answer) => pickOf(answer, count, fallback));
      const choice = spec.choices[pick - 1];

      if (choice === undefined) {
        return BACK;
      }

      printCollapse(spec.collapsed(choice.value));

      return choice.value;
    },
    multiselect,
    confirm: async (spec) => {
      print(detailOf(spec.detail));

      const query = `${spec.title} (${spec.initial ? "Y/n" : "y/N"}): `;
      const value = await askUntil(query, (answer) => yesNoOf(answer, spec.initial));

      printCollapse(spec.collapsed(value));

      return value;
    },
    path,
    number: async (spec) => {
      const value = await numberRound(spec, spec.initial);

      printCollapse(spec.collapsed(value));

      return value;
    },
    task,
    note: (lines) => print(typeof lines === "function" ? lines(room()) : lines),
  };
};
