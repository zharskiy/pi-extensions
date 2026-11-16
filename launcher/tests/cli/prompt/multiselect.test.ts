import { describe, expect, it } from "vitest";
import { BACK, type Choice } from "../../../cli/prompt/types.ts";
import { KEY, outcome, pause, press, richPrompts } from "./fake-tty.ts";

const ADD = "add";

const FOLDERS = {
  title: "Which folders hold your projects?",
  detail: ["Only these folders are shared with the sandbox VM."],
  choices: [
    { value: "~/Projects", label: "~/Projects", tag: "14 git repositories" },
    { value: "~/work", label: "~/work", tag: "3 git repositories · you are here" },
    { value: "~/src", label: "~/src", tag: "no git repository found" },
    { value: ADD, label: "+ Add another folder…", action: true as const },
  ],
  checked: ["~/Projects", "~/work"],
  escape: "cancel",
  plain: { help: ["Type numbers to switch folders on or off."], label: "Folders" },
  collapsed: (values: string[]) => ({
    title: "Which folders hold your projects?",
    text: values.join(", ") || "none",
  }),
};

describe("multiselect", () => {
  it("draws boxes, tags and the action item, and continues with the checked set on Enter", async () => {
    const { prompts, screen, input } = richPrompts();
    const reply = prompts.multiselect(FOLDERS);

    await pause();

    expect(screen.lines()).toEqual([
      "◆  Which folders hold your projects?",
      "│  Only these folders are shared with the sandbox VM.",
      "│",
      "│  › ■ ~/Projects   14 git repositories",
      "│    ■ ~/work       3 git repositories · you are here",
      "│    □ ~/src        no git repository found",
      "│    + Add another folder…",
      "│",
      "│  ↑↓ move · space select · enter continue · esc/ctrl-c cancel",
    ]);

    await press(input, KEY.enter);

    expect(await reply).toEqual(["~/Projects", "~/work"]);
  });

  it("toggles with Space and returns the values in list order", async () => {
    const { prompts, input } = richPrompts();
    const reply = prompts.multiselect(FOLDERS);

    await press(input, KEY.space, KEY.down, KEY.down, KEY.space, KEY.enter);

    expect(await reply).toEqual(["~/work", "~/src"]);
  });

  it("runs the action item, appends the new folder checked with the cursor on it", async () => {
    const { prompts, screen, input } = richPrompts();
    const asked: string[] = [];

    const onAction = async (value: string): Promise<Choice<string>> => {
      asked.push(value);

      expect(screen.lines()).toEqual([]);

      return { value: "~/oss", label: "~/oss" };
    };

    const reply = prompts.multiselect({ ...FOLDERS, onAction });

    await press(input, KEY.up, KEY.enter);

    await pause();

    expect(asked).toEqual([ADD]);

    expect(screen.lines()).toContain("│  › ■ ~/oss");

    expect(screen.lines().at(-3)).toBe("│    + Add another folder…");

    await press(input, KEY.enter);

    expect(await reply).toEqual(["~/Projects", "~/work", "~/oss"]);
  });

  it("can nest another prompt inside the action and come back to the list", async () => {
    const { prompts, screen, input } = richPrompts();

    const onAction = async (): Promise<Choice<string> | undefined> => {
      const typed = await prompts.path({
        title: "Add a folder",
        initial: "~/",
        home: "/home/me",
        readdir: () => [],
        collapsed: () => undefined,
      });

      return typed === BACK ? undefined : { value: typed, label: typed };
    };

    const reply = prompts.multiselect({ ...FOLDERS, onAction });

    await press(input, KEY.end, KEY.enter);

    await pause();

    expect(screen.lines()[0]).toBe("◆  Add a folder");

    await press(input, KEY.escape);

    expect(screen.lines()[0]).toBe("◆  Which folders hold your projects?");

    await press(input, KEY.enter, "oss", KEY.enter);

    await pause();

    expect(screen.lines()).toContain("│  › ■ ~/oss");

    await press(input, KEY.enter);

    expect(await reply).toEqual(["~/Projects", "~/work", "~/oss"]);
  });

  it("offers only enter choose when nothing can be toggled", async () => {
    const { prompts, screen, input } = richPrompts();
    const reply = outcome(
      prompts.multiselect({ ...FOLDERS, choices: FOLDERS.choices.slice(3), checked: [] }),
    );

    await pause();

    expect(screen.lines()).toContain("│  › + Add another folder…");

    expect(screen.lines().at(-1)).toBe("│  ↑↓ move · enter choose · esc/ctrl-c cancel");

    await press(input, KEY.ctrlC);

    expect((await reply).error).toMatchObject({ cause: "interrupt" });
  });
});
