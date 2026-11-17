import { describe, expect, it } from "vitest";
import { BACK } from "../../../cli/prompt/types.ts";
import { KEY, outcome, pasted, pause, press, richPrompts } from "./fake-tty.ts";

const HOME = "/home/me";

const TREE: Record<string, string[]> = {
  [HOME]: ["Pictures", "Projects", "Public", ".config", "work"],
  [`${HOME}/Projects`]: ["app", "api"],
};

const readdir = (dir: string) => {
  const names = TREE[dir];

  if (names === undefined) {
    throw new Error("ENOENT");
  }

  return names;
};

const NAME = {
  title: "Name",
  home: HOME,
  readdir,
  collapsed: (value: string) => ({ title: "Name", text: value }),
};

const FOLDER = { ...NAME, title: "Add a folder", initial: "~/", enter: "add" };

describe("path", () => {
  it("pre-fills the initial value, places the cursor after it and submits on Enter", async () => {
    const { prompts, screen, input } = richPrompts();
    const reply = prompts.path({ ...NAME, initial: "box" });

    await pause();

    expect(screen.lines()).toEqual([
      "◆  Name",
      "│  › box",
      "│  tab completes · enter continue · esc back · ctrl-c cancel",
    ]);

    expect(screen.cursor()).toEqual({ row: 1, column: 8 });

    expect(screen.flags()).toEqual({ cursorHidden: false, paste: true });

    await press(input, KEY.enter);

    expect(await reply).toBe("box");

    expect(screen.lines()).toEqual(["◇  Name", "│  box", "│"]);

    expect(screen.flags()).toEqual({ cursorHidden: false, paste: false });
  });

  it("handles every editing key", async () => {
    const { prompts, input } = richPrompts();
    const reply = prompts.path({ ...NAME });

    await press(input, "hello world");

    await press(input, KEY.ctrlW, "there", KEY.home, ">", KEY.ctrlE, "!", KEY.left, KEY.left, KEY.backspace);

    await press(input, KEY.right, KEY.delete, KEY.ctrlA, KEY.delete, KEY.end, KEY.altBackspace, "x");

    await press(input, KEY.ctrlA, KEY.right, KEY.ctrlK, "-", KEY.ctrlD, KEY.ctrlU, "a", KEY.enter);

    expect(await reply).toBe("a");
  });

  it("deletes right with ctrl-d and cancels with it only on an empty line", async () => {
    const { prompts, input } = richPrompts();
    const reply = outcome(prompts.path({ ...NAME, initial: "ab" }));

    await press(input, KEY.home, KEY.ctrlD, KEY.ctrlD, KEY.ctrlD);

    expect((await reply).error).toMatchObject({ cause: "end" });
  });

  it("shows the validator's message after Enter and clears it on the next edit", async () => {
    const { prompts, screen, input } = richPrompts();
    const validate = (value: string) => (value === "~/" ? "Type the path of a folder." : undefined);
    const reply = prompts.path({ ...FOLDER, validate });

    await press(input, KEY.enter);

    expect(screen.lines()).toEqual([
      "◆  Add a folder",
      "│  › ~/",
      "│  ✖ Type the path of a folder.",
      "│  tab completes · enter add · esc back · ctrl-c cancel",
    ]);

    await press(input, "w");

    expect(screen.lines()).toEqual([
      "◆  Add a folder",
      "│  › ~/w",
      "│  tab completes · enter add · esc back · ctrl-c cancel",
    ]);

    await press(input, KEY.escape);

    expect(await reply).toBe(BACK);
  });

  it("inserts a one-line paste as one edit and strips control characters", async () => {
    const { prompts, input } = richPrompts();
    const reply = prompts.path({ ...NAME });

    await press(input, "a", pasted("b\x07c\td"), "e", KEY.enter);

    expect(await reply).toBe("abcde");
  });

  it("keeps only the first line of a paste and says so until the next edit", async () => {
    const { prompts, screen, input } = richPrompts();
    const reply = prompts.path({ ...NAME });

    await press(input, pasted("one\rtwo\r\nthree"));

    expect(screen.lines()).toContain("│  › one");

    expect(screen.lines()).toContain("│  ▲ Pasted text had several lines; only the first was kept.");

    await press(input, KEY.backspace);

    expect(screen.lines().join("\n")).not.toContain("Pasted text");

    await press(input, KEY.enter);

    expect(await reply).toBe("on");
  });

  it("unquotes a dragged path and turns backslash-space into a space", async () => {
    const { prompts, input } = richPrompts();
    const reply = prompts.path({ ...FOLDER, initial: "" });

    await press(
      input,
      pasted("'/Users/me/My Folder' "),
      KEY.ctrlU,
      pasted("/Users/me/My\\ Folder "),
      KEY.enter,
    );

    expect(await reply).toBe("/Users/me/My Folder");
  });

  it("assembles a paste split across two chunks", async () => {
    const { prompts, input } = richPrompts();
    const reply = prompts.path({ ...NAME });

    await press(input, "\x1b[200~ab", "cd\x1b[20", "1~", KEY.enter);

    expect(await reply).toBe("abcd");
  });

  it("deletes a whole path segment with ctrl-w in a path input", async () => {
    const { prompts, input } = richPrompts();
    const reply = prompts.path({ ...FOLDER, initial: "~/Projects/app" });

    await press(input, KEY.ctrlW, KEY.ctrlW, "x", KEY.enter);

    expect(await reply).toBe("~/x");
  });

  it("completes one match with a slash, a common prefix, and lists matches on a second Tab", async () => {
    const { prompts, screen, input } = richPrompts();
    const reply = prompts.path(FOLDER);

    await press(input, "w", KEY.tab);

    expect(screen.lines()).toContain("│  › ~/work/");

    await press(input, KEY.ctrlU, "~/P", KEY.tab);

    expect(screen.lines()).toContain("│  › ~/P");

    expect(screen.lines().join("\n")).not.toContain("~/Pictures/");

    await press(input, KEY.tab);

    expect(screen.lines()).toContain("│    ~/Pictures/   ~/Projects/   ~/Public/");

    await press(input, "r", KEY.tab);

    expect(screen.lines()).toContain("│  › ~/Projects/");

    expect(screen.lines().join("\n")).not.toContain("~/Pictures/");

    await press(input, KEY.tab, KEY.tab);

    expect(screen.lines()).toContain("│    ~/Projects/api/   ~/Projects/app/");

    await press(input, KEY.enter);

    expect(await reply).toBe("~/Projects/ap");
  });

  it("offers hidden folders only when the typed segment starts with a dot", async () => {
    const { prompts, screen, input } = richPrompts();
    const reply = prompts.path(FOLDER);

    await press(input, KEY.tab, KEY.tab);

    expect(screen.lines().join("\n")).not.toContain(".config");

    await press(input, ".", KEY.tab);

    expect(screen.lines()).toContain("│  › ~/.config/");

    await press(input, KEY.ctrlU, "/nowhere/x", KEY.tab, KEY.enter);

    expect(await reply).toBe("/nowhere/x");
  });

  it("scrolls a long value so the cursor stays on screen", async () => {
    const { prompts, screen, input } = richPrompts({ columns: 40 });
    const reply = prompts.path({ ...NAME });

    await press(input, "a".repeat(60));

    const row = screen.lines()[1] ?? "";

    expect(row.startsWith("│  › …")).toBe(true);

    expect(row.length).toBeLessThanOrEqual(39);

    expect(screen.cursor()).toEqual({ row: 1, column: row.length });

    await press(input, KEY.enter);

    expect(await reply).toBe("a".repeat(60));
  });

  it("redraws at a smaller width without stale lines while the cursor sits inside the frame", async () => {
    const { prompts, screen, input, output } = richPrompts();
    const validate = () => "That path is not usable here, because this message is long enough to fill a row.";
    const reply = prompts.path({ ...FOLDER, initial: `~/${"deep/".repeat(12)}`, validate });

    await press(input, KEY.enter);

    expect(screen.cursor().row).toBe(1);

    output.resize(50);

    await pause();

    const lines = screen.lines();

    expect(lines.filter((line) => line.startsWith("◆"))).toEqual(["◆  Add a folder"]);

    expect(lines.filter((line) => line.includes("tab completes"))).toHaveLength(1);

    expect(lines.every((line) => line.length <= 49)).toBe(true);

    await press(input, KEY.escape);

    expect(await reply).toBe(BACK);

    expect(screen.lines()).toEqual([]);
  });
});
