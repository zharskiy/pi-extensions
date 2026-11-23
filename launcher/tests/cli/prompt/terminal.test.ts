import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createRichPrompts } from "../../../cli/prompt/rich.ts";
import { findTerminal, uiOf, withTerminal } from "../../../cli/prompt/terminal.ts";
import { BACK } from "../../../cli/prompt/types.ts";
import { fakeInput, fakeOutput, fakeUi, KEY, outcome, press, richPrompts } from "./fake-tty.ts";

const ENV = { TERM: "xterm-256color", LANG: "en_US.UTF-8" };

const SGR = String.fromCharCode(27);

describe("finding the terminal", () => {
  it("uses stdin and stderr when both are terminals, without opening /dev/tty", () => {
    const stdin = fakeInput();
    const stderr = fakeOutput();
    const opened: string[] = [];

    const ui = findTerminal({
      stdin,
      stderr,
      env: ENV,
      openTty: () => {
        opened.push("tty");

        return undefined;
      },
    });

    expect(ui?.input).toBe(stdin);

    expect(ui?.output).toBe(stderr);

    expect(opened).toEqual([]);
  });

  it("falls back to /dev/tty when stdin is piped, and closes it on restore", () => {
    const tty = { input: fakeInput(), output: fakeOutput(), closed: 0 };

    const ui = findTerminal({
      stdin: fakeInput(false),
      stderr: fakeOutput(),
      env: ENV,
      openTty: () => ({ input: tty.input, output: tty.output, close: () => (tty.closed += 1) }),
    });

    expect(ui?.input).toBe(tty.input);

    ui?.session.restore();

    ui?.session.restore();

    expect(tty.closed).toBe(1);
  });

  it("finds no terminal when /dev/tty cannot be opened", () => {
    const opened: string[] = [];

    const throwing = () => {
      opened.push("tty");

      throw new Error("ENXIO");
    };

    const deps = { stdin: fakeInput(false), stderr: fakeOutput(80, 24, false), openTty: throwing };

    expect(findTerminal({ ...deps, env: ENV })).toBeUndefined();

    expect(opened).toEqual(["tty"]);
  });
});

describe("modes, glyphs and colour", () => {
  const uiWith = (env: NodeJS.ProcessEnv, columns = 80, tty = true) =>
    uiOf({ input: fakeInput(tty), output: fakeOutput(columns, 24, tty) }, { env });

  it("is rich on a capable terminal and plain on request, on a dumb or unset TERM, or below 40 columns", () => {
    expect(uiWith(ENV).mode).toBe("rich");

    expect(uiWith({ ...ENV, PI_SANDBOX_PLAIN: "1" }).mode).toBe("plain");

    expect(uiWith({ ...ENV, PI_SANDBOX_PLAIN: "" }).mode).toBe("rich");

    expect(uiWith({ ...ENV, TERM: "dumb" }).mode).toBe("plain");

    expect(uiWith({ LANG: "en_US.UTF-8" }).mode).toBe("plain");

    expect(uiWith(ENV, 39).mode).toBe("plain");
  });

  it("uses Unicode only for a UTF-8 locale outside the Linux console", () => {
    expect(uiWith({ TERM: "xterm", LC_ALL: "en_US.UTF-8", LANG: "C" }).unicode).toBe(true);

    expect(uiWith({ TERM: "xterm", LC_ALL: "", LC_CTYPE: "en_US.utf8" }).unicode).toBe(true);

    expect(uiWith({ TERM: "xterm", LANG: "C" }).unicode).toBe(false);

    expect(uiWith({ TERM: "linux", LANG: "en_US.UTF-8" }).unicode).toBe(false);
  });

  it("colours a terminal unless NO_COLOR is set, and FORCE_COLOR colours a non-terminal", () => {
    expect(uiWith(ENV).colour).toBe(true);

    expect(uiWith({ ...ENV, NO_COLOR: "1" }).colour).toBe(false);

    expect(uiWith(ENV, 80, false).colour).toBe(false);

    expect(uiWith({ ...ENV, FORCE_COLOR: "1" }, 80, false).colour).toBe(true);

    expect(uiWith({ ...ENV, FORCE_COLOR: "0" }).colour).toBe(false);

    expect(uiWith({ TERM: "dumb", FORCE_COLOR: "1" }).colour).toBe(false);
  });

  it("writes no SGR sequence with NO_COLOR", async () => {
    const plainColour = richPrompts({ env: { NO_COLOR: "1" } });
    const reply = plainColour.prompts.select({
      collapsed: () => undefined,
      title: "Pick",
      choices: [{ value: 1, label: "one", tag: "tag" }],
    });

    await press(plainColour.input, KEY.enter);

    await reply;

    expect(plainColour.output.text()).not.toMatch(new RegExp(`${SGR}\\[[0-9;]*m`));

    const coloured = richPrompts();
    const again = coloured.prompts.select({
      collapsed: () => undefined,
      title: "Pick",
      choices: [{ value: 1, label: "one", tag: "tag" }],
    });

    await press(coloured.input, KEY.enter);

    await again;

    expect(coloured.output.text()).toMatch(new RegExp(`${SGR}\\[[0-9;]*m`));
  });

  it("draws the ASCII glyphs when the locale is not UTF-8", async () => {
    const { prompts, screen, input } = richPrompts({ env: { LANG: "C" } });

    const reply = prompts.select({
      collapsed: (value) => ({ title: "Folders…", text: value }),
      title: "Folders…",
      radio: true,
      choices: [
        { value: "~/a", label: "~/a", tag: "1 git repository · you are here" },
        { value: "~/b", label: "~/b" },
      ],
    });

    await press(input, KEY.end);

    expect(screen.lines()).toEqual([
      "*  Folders...",
      "|    ( ) ~/a   1 git repository, you are here",
      "|  > (*) ~/b",
      "|  up/down move, enter choose, esc back, ctrl-c cancel",
    ]);

    await press(input, KEY.enter);

    await reply;

    expect(screen.lines()).toEqual(["o  Folders...", "|  ~/b", "|"]);
  });

  it("wraps a long title and the detail at the width, keeping the rail", async () => {
    const { prompts, screen, input } = richPrompts({ columns: 40 });

    const reply = prompts.select({
      collapsed: () => undefined,
      title: "A title that is much longer than forty columns wide",
      detail: ["Every pi session runs in this VM. Automatic follows this Mac."],
      choices: [{ value: 1, label: "one" }],
    });

    await press(input, KEY.ctrlL);

    expect(screen.lines().slice(0, 5)).toEqual([
      "◆  A title that is much longer than",
      "│  forty columns wide",
      "│  Every pi session runs in this VM.",
      "│  Automatic follows this Mac.",
      "│",
    ]);

    expect(screen.lines().at(-2)).toBe("│  ↑↓ move · enter choose · esc back ·");

    expect(screen.lines().at(-1)).toBe("│  ctrl-c cancel");

    await press(input, KEY.enter);

    await reply;
  });

  it("lets a detail function lay the lines out for the current text room", async () => {
    const { prompts, screen, input, output } = richPrompts();
    const widths: number[] = [];

    const detail = (room: number) => {
      widths.push(room);

      return [room < 60 ? "narrow" : "wide"];
    };

    const reply = prompts.select({
      collapsed: () => ({ title: "Review", text: "Apply" }),
      title: "Review",
      detail,
      choices: [{ value: 1, label: "Apply" }],
    });

    await press(input, KEY.ctrlL);

    output.resize(50);

    await press(input, KEY.enter);

    await reply;

    expect(widths.at(0)).toBe(76);

    expect(widths.at(-1)).toBe(46);

    expect(screen.lines()).toEqual(["◇  Review", "│  Apply", "│"]);
  });
});

describe("notes", () => {
  it("prints rail, header, step and end lines", () => {
    const { ui, screen } = fakeUi();
    const prompts = createRichPrompts(ui);

    prompts.note(["pi sandbox setup", ""], "start");

    prompts.note(["Sets up the sandbox.", ""]);

    prompts.note(["Sandbox VM", "✔ Created in 54s"], "step");

    prompts.note(["Done. The sandbox is ready.", "", "Next      cd ~/x && pi"], "end");

    expect(screen.lines()).toEqual([
      "┌  pi sandbox setup",
      "│",
      "│  Sets up the sandbox.",
      "│",
      "◇  Sandbox VM",
      "│  ✔ Created in 54s",
      "└  Done. The sandbox is ready.",
      "",
      "   Next      cd ~/x && pi",
    ]);
  });
});

describe("terminal restore", () => {
  const restored = (fake: ReturnType<typeof richPrompts>) => ({
    lastRaw: fake.input.rawCalls.at(-1),
    flags: fake.screen.flags(),
  });

  const RESTORED = { lastRaw: false, flags: { cursorHidden: false, paste: false } };

  it("leaves raw mode, shows the cursor and turns paste off after a value, BACK and Cancelled", async () => {
    const valued = richPrompts();
    const first = valued.prompts.path({
      collapsed: () => undefined,
      title: "Name",
      home: "/home/me",
      readdir: () => [],
    });

    await press(valued.input, "x", KEY.enter);

    expect(await first).toBe("x");

    expect(restored(valued)).toEqual(RESTORED);

    const backed = richPrompts();
    const second = backed.prompts.select({
      collapsed: () => undefined,
      title: "Pick",
      choices: [{ value: 1, label: "one" }],
    });

    await press(backed.input, KEY.escape);

    expect(await second).toBe(BACK);

    expect(restored(backed)).toEqual(RESTORED);

    const cancelled = richPrompts();
    const third = outcome(
      cancelled.prompts.path({ collapsed: () => undefined, title: "Add", home: "/", readdir: () => [] }),
    );

    await press(cancelled.input, KEY.ctrlC);

    expect((await third).error).toMatchObject({ cause: "interrupt" });

    expect(restored(cancelled)).toEqual(RESTORED);
  });

  it("restores the terminal when a validator throws, and passes the error on", async () => {
    const fake = richPrompts();

    const reply = outcome(
      fake.prompts.path({
        collapsed: () => undefined,
        title: "Name",
        home: "/home/me",
        readdir: () => [],
        validate: () => {
          throw new Error("validator broke");
        },
      }),
    );

    await press(fake.input, KEY.enter);

    expect((await reply).error).toEqual(new Error("validator broke"));

    expect(restored(fake)).toEqual(RESTORED);
  });

  it("restores once, even when called twice", () => {
    const { ui, output, input } = fakeUi();

    ui.session.raw(true);

    ui.session.cursor(false);

    ui.session.paste(true);

    const before = output.text().length;

    ui.session.restore();

    const written = output.text().slice(before);

    ui.session.restore();

    expect(written).toBe("\x1b[?2004l\x1b[?25h");

    expect(output.text().slice(before)).toBe(written);

    expect(input.rawCalls).toEqual([true, false]);

    expect(input.isPaused()).toBe(true);
  });

  it("refuses to start a prompt or a task once restored, and leaves the terminal restored", async () => {
    const fake = richPrompts();

    fake.ui.session.restore();

    const reply = outcome(
      fake.prompts.select({
        collapsed: () => undefined,
        title: "Pick",
        choices: [{ value: 1, label: "one" }],
      }),
    );
    const task = outcome(fake.prompts.task({ title: "", interruptWarning: "", run: async () => 1 }));

    expect((await reply).error).toMatchObject({ cause: "end" });
    expect((await task).error).toMatchObject({ cause: "end" });
    expect(fake.input.rawCalls).toEqual([]);
    expect(fake.screen.flags()).toEqual({ cursorHidden: false, paste: false });
  });

  it("restores on SIGTERM and SIGHUP, on exit and after the run, and removes its listeners", async () => {
    const { ui, input, screen } = fakeUi();
    const signals = new EventEmitter();
    const exits = new EventEmitter();
    const received: string[] = [];

    const run = withTerminal(
      ui,
      { signals, exits, onSignal: (signal) => received.push(signal) },
      async () => {
        ui.session.raw(true);

        ui.session.cursor(false);

        expect(signals.listenerCount("SIGTERM")).toBe(1);

        expect(exits.listenerCount("exit")).toBe(1);

        signals.emit("SIGTERM");

        return "ran";
      },
    );

    expect(await run).toBe("ran");

    expect(received).toEqual(["SIGTERM"]);

    expect(input.rawCalls.at(-1)).toBe(false);

    expect(screen.flags().cursorHidden).toBe(false);

    expect([
      signals.listenerCount("SIGTERM"),
      signals.listenerCount("SIGHUP"),
      exits.listenerCount("exit"),
    ]).toEqual([0, 0, 0]);
  });

  it("restores when the run throws", async () => {
    const { ui, input } = fakeUi();

    const run = withTerminal(ui, { onSignal: () => undefined }, async () => {
      ui.session.raw(true);

      throw new Error("boom");
    });

    await expect(run).rejects.toThrow("boom");

    expect(input.rawCalls).toEqual([true, false]);
  });
});
