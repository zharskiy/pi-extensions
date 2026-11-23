import { describe, expect, it } from "vitest";
import { KEY, outcome, pause, plainPrompts, press } from "./fake-tty.ts";

const answer = async (input: ReturnType<typeof plainPrompts>["input"], line: string) => {
  await pause();

  await press(input, `${line}\r`);

  await pause();
};

describe("plain prompts", () => {
  it("numbers a select, takes the default on Enter and re-asks out of range", async () => {
    const { prompts, screen, input } = plainPrompts();

    const reply = prompts.select({
      title: "Review",
      choices: ["Apply", "Change project folders", "Cancel"].map((label) => ({ value: label, label })),
      collapsed: () => undefined,
    });

    await answer(input, "4");

    await answer(input, "");

    expect(await reply).toBe("Apply");

    expect(screen.lines()).toEqual([
      "Review",
      "  1) Apply",
      "  2) Change project folders",
      "  3) Cancel",
      "Choose [1]: 4",
      "Error: Type a number from 1 to 3.",
      "Choose [1]:",
    ]);
  });

  it("reads y, yes, n and no in any case, the default on Enter, and re-asks otherwise", async () => {
    const { prompts, screen, input } = plainPrompts();
    const spec = {
      title: "Restart the sandbox VM now?",
      yes: "Yes",
      no: "No",
      initial: false,
      collapsed: () => undefined,
    };
    const first = prompts.confirm(spec);

    await answer(input, "maybe");

    await answer(input, "YES");

    expect(await first).toBe(true);

    expect(screen.lines().slice(0, 3)).toEqual([
      "Restart the sandbox VM now? (y/N): maybe",
      "Error: Type y or n.",
      "Restart the sandbox VM now? (y/N): YES",
    ]);

    const second = prompts.confirm(spec);

    await answer(input, "");

    expect(await second).toBe(false);
  });

  it("asks a number with its bounds, re-asks on errors and confirms a warning with Enter", async () => {
    const { prompts, screen, input } = plainPrompts();

    const reply = prompts.number({
      title: "Memory for the VM, in GiB",
      initial: 10,
      min: 2,
      max: 30,
      step: 1,
      tooLow: "too low",
      tooHigh: "too high",
      warn: (value) => (value > 24 ? "That leaves little memory for macOS." : undefined),
      collapsed: () => undefined,
    });

    await answer(input, "1");

    await answer(input, "8.5");

    await answer(input, "26");

    await answer(input, "");

    expect(await reply).toBe(26);

    expect(screen.lines()).toEqual([
      "Memory for the VM, in GiB, 2 to 30 [10]: 1",
      "Error: too low",
      "Memory for the VM, in GiB, 2 to 30 [10]: 8.5",
      "Error: Type a whole number, like 10.",
      "Memory for the VM, in GiB, 2 to 30 [10]: 26",
      "Warning: That leaves little memory for macOS.",
      "Memory for the VM, in GiB, 2 to 30 [26]:",
    ]);
  });

  it("validates a path's empty answer as its initial text", async () => {
    const { prompts, screen, input } = plainPrompts();
    const path = prompts.path({
      title: "Add a folder",
      initial: "~/",
      home: "/home/me",
      readdir: () => [],
      validate: (value) => (value === "~/" ? "Type the path of a folder." : undefined),
      collapsed: () => undefined,
    });

    await answer(input, "");

    await answer(input, "~/oss");

    expect(await path).toBe("~/oss");

    expect(screen.lines().slice(-3)).toEqual([
      "Add a folder [~/]:",
      "Error: Type the path of a folder.",
      "Add a folder [~/]: ~/oss",
    ]);
  });

  it("maps ctrl-c to Cancelled interrupt and ctrl-d or input end to Cancelled end", async () => {
    const interrupted = plainPrompts();
    const first = outcome(
      interrupted.prompts.path({
        collapsed: () => undefined,
        title: "Name",
        home: "/home/me",
        readdir: () => [],
      }),
    );

    await pause();

    await press(interrupted.input, KEY.ctrlC);

    expect((await first).error).toMatchObject({ cause: "interrupt" });

    expect(interrupted.input.isRaw).toBe(false);

    const ended = plainPrompts();
    const second = outcome(
      ended.prompts.path({ collapsed: () => undefined, title: "Name", home: "/home/me", readdir: () => [] }),
    );

    await pause();

    await press(ended.input, KEY.ctrlD);

    expect((await second).error).toMatchObject({ cause: "end" });

    const closed = plainPrompts();
    const third = outcome(
      closed.prompts.path({ collapsed: () => undefined, title: "Name", home: "/home/me", readdir: () => [] }),
    );

    await pause();

    closed.input.end();

    expect((await third).error).toMatchObject({ cause: "end" });
  });

  it("reads lines without raw mode or cursor sequences on a dumb or unset TERM", async () => {
    const dumb = plainPrompts({ env: { TERM: "dumb" } });
    const unset = plainPrompts({ env: { TERM: "" } });
    const named = dumb.prompts.path({
      collapsed: () => undefined,
      title: "Name",
      home: "/home/me",
      readdir: () => [],
      initial: "pi",
    });
    const other = unset.prompts.path({
      collapsed: () => undefined,
      title: "Name",
      home: "/home/me",
      readdir: () => [],
    });

    await answer(dumb.input, "box");

    await answer(unset.input, "vm");

    expect(await named).toBe("box");
    expect(await other).toBe("vm");
    expect(dumb.input.rawCalls).toEqual([]);
    expect(unset.input.rawCalls).toEqual([]);
    expect(dumb.output.text()).not.toContain("\x1b");
    expect(unset.output.text()).not.toContain("\x1b");
  });

  it("prints notes as plain ASCII lines", () => {
    const { prompts, screen } = plainPrompts();

    prompts.note(["Checking this Mac and the sandbox VM…", "This Mac: 12 CPUs · 32 GiB memory"], "start");

    expect(screen.lines()).toEqual([
      "Checking this Mac and the sandbox VM...",
      "This Mac: 12 CPUs, 32 GiB memory",
    ]);
  });
});
