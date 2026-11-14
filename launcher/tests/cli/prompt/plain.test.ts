import { describe, expect, it } from "vitest";
import { BACK, type Choice } from "../../../cli/prompt/types.ts";
import { KEY, outcome, pause, plainPrompts, press } from "./fake-tty.ts";

const answer = async (input: ReturnType<typeof plainPrompts>["input"], line: string) => {
  await pause();

  await press(input, `${line}\r`);

  await pause();
};

const FOLDERS = {
  title: "Which folders hold your projects?",
  detail: ["Only these folders are shared with the sandbox VM, and pi starts only inside them."],
  choices: [
    { value: "~/Projects", label: "~/Projects", tag: "14 git repositories" },
    { value: "~/work", label: "~/work", tag: "3 git repositories, you are here" },
    { value: "~/src", label: "~/src", tag: "no git repository found" },
    { value: "add", label: "+ Add another folder…", action: true as const },
  ],
  checked: ["~/Projects", "~/work"],
  collapsed: (values: string[]) => ({ title: "Project folders", text: values.join(", ") }),
  plain: {
    help: [
      "Type numbers to switch folders on or off (like 1 3), a path to add a folder,",
      "or press Enter to keep the selection.",
    ],
    label: "Folders",
  },
};

describe("plain prompts", () => {
  it("prints the folder question as numbered lines and keeps the selection on Enter", async () => {
    const { prompts, screen, input } = plainPrompts({ columns: 100 });
    const reply = prompts.multiselect(FOLDERS);

    await answer(input, "");

    expect(await reply).toEqual(["~/Projects", "~/work"]);

    expect(screen.lines()).toEqual([
      "Which folders hold your projects?",
      "Only these folders are shared with the sandbox VM, and pi starts only inside them.",
      "  1) [x] ~/Projects (14 git repositories)",
      "  2) [x] ~/work (3 git repositories, you are here)",
      "  3) [ ] ~/src (no git repository found)",
      "Type numbers to switch folders on or off (like 1 3), a path to add a folder,",
      "or press Enter to keep the selection.",
      "Folders [1 2]:",
      "Project folders: ~/Projects, ~/work",
    ]);

    expect(input.isRaw).toBe(false);
  });

  it("toggles by numbers, re-asks after an invalid answer, and adds a typed path through the action", async () => {
    const { prompts, screen, input } = plainPrompts();
    const asked: string[] = [];

    const onAction = async (): Promise<Choice<string> | undefined> => {
      const typed = await prompts.path({
        title: "Add a folder",
        home: "/home/me",
        readdir: () => [],
        validate: (value) => (value === "~/nope" ? "~/nope does not exist." : undefined),
        collapsed: () => undefined,
      });

      asked.push(String(typed));

      return typed === BACK ? undefined : { value: typed, label: typed };
    };

    const reply = prompts.multiselect({ ...FOLDERS, onAction });

    await answer(input, "1 3");

    await answer(input, "7");

    await answer(input, "~/nope");

    await answer(input, "~/oss");

    await answer(input, "");

    expect(await reply).toEqual(["~/work", "~/src", "~/oss"]);

    expect(asked).toEqual(["~/oss"]);

    const lines = screen.lines();

    expect(lines).toContain("Folders [2 3]: 7");

    expect(lines).toContain("Error: Type numbers from 1 to 3, a path, or press Enter.");

    expect(lines).toContain("Error: ~/nope does not exist.");

    expect(lines).toContain("  4) [x] ~/oss");

    expect(lines.at(-1)).toBe("Project folders: ~/work, ~/src, ~/oss");
  });

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
      title: "Share your whole home with the sandbox VM instead?",
      yes: "Yes",
      no: "No",
      initial: false,
    };
    const first = prompts.confirm(spec);

    await answer(input, "maybe");

    await answer(input, "YES");

    expect(await first).toBe(true);

    expect(screen.lines().slice(0, 3)).toEqual([
      "Share your whole home with the sandbox VM instead? (y/N): maybe",
      "Error: Type y or n.",
      "Share your whole home with the sandbox VM instead? (y/N): YES",
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
      hint: "2 to 30",
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

  it("takes the default text on Enter, and a path's empty answer means back", async () => {
    const { prompts, input } = plainPrompts();
    const text = prompts.text({ title: "Name", initial: "box" });

    await answer(input, "");

    expect(await text).toBe("box");

    const path = prompts.path({ title: "Add a folder", home: "/home/me", readdir: () => [] });

    await answer(input, "");

    expect(await path).toBe(BACK);
  });

  it("maps ctrl-c to Cancelled interrupt and ctrl-d or input end to Cancelled end", async () => {
    const interrupted = plainPrompts();
    const first = outcome(interrupted.prompts.text({ title: "Name" }));

    await pause();

    await press(interrupted.input, KEY.ctrlC);

    expect((await first).error).toMatchObject({ cause: "interrupt" });

    expect(interrupted.input.isRaw).toBe(false);

    const ended = plainPrompts();
    const second = outcome(ended.prompts.text({ title: "Name" }));

    await pause();

    await press(ended.input, KEY.ctrlD);

    expect((await second).error).toMatchObject({ cause: "end" });

    const closed = plainPrompts();
    const third = outcome(closed.prompts.text({ title: "Name" }));

    await pause();

    closed.input.end();

    expect((await third).error).toMatchObject({ cause: "end" });
  });

  it("reads lines without raw mode or cursor sequences on a dumb or unset TERM", async () => {
    const dumb = plainPrompts({ env: { TERM: "dumb" } });
    const unset = plainPrompts({ env: { TERM: "" } });
    const named = dumb.prompts.text({ title: "Name", initial: "pi" });
    const other = unset.prompts.text({ title: "Name" });

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
