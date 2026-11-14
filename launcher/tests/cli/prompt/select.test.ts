import { describe, expect, it } from "vitest";
import { BACK, Cancelled } from "../../../cli/prompt/types.ts";
import { KEY, outcome, pause, press, richPrompts } from "./fake-tty.ts";

const HUB = {
  title: "Review",
  detail: ["When you apply:", "  • create the config file"],
  choices: [
    { value: "apply", label: "Apply" },
    { value: "folders", label: "Change project folders" },
    { value: "vm", label: "Change VM size" },
    { value: "cancel", label: "Cancel" },
  ],
  escape: "cancel",
};

describe("select", () => {
  it("draws the frame with the detail, the pointer on the first item and the key hints", async () => {
    const { prompts, screen, input } = richPrompts();
    const reply = prompts.select(HUB);

    await pause();

    expect(screen.lines()).toEqual([
      "◆  Review",
      "│  When you apply:",
      "│    • create the config file",
      "│",
      "│  › Apply",
      "│    Change project folders",
      "│    Change VM size",
      "│    Cancel",
      "│",
      "│  ↑↓ move · enter choose · esc cancel · ctrl-c cancel",
    ]);

    await press(input, KEY.enter);

    expect(await reply).toBe("apply");
  });

  it("moves with the arrows and ctrl-p/ctrl-n, wraps at both ends, and jumps with Home and End", async () => {
    const { prompts, input } = richPrompts();
    const reply = prompts.select(HUB);

    await press(input, KEY.up, KEY.up, KEY.ctrlN, KEY.ctrlP, KEY.home, KEY.down, KEY.end, KEY.down, KEY.down);

    await press(input, KEY.enter);

    expect(await reply).toBe("folders");
  });

  it("starts on the initial value and collapses to the chosen label", async () => {
    const { prompts, screen, input } = richPrompts();
    const reply = prompts.select({ ...HUB, initial: "vm" });

    await press(input, KEY.enter);

    expect(await reply).toBe("vm");

    expect(screen.lines()).toEqual(["◇  Review", "│  Change VM size", "│"]);
  });

  it("uses the collapsed text and title the spec gives, and prints nothing for undefined", async () => {
    const first = richPrompts();
    const titled = first.prompts.select({ ...HUB, collapsed: () => ({ title: "Settings", text: "on" }) });

    await press(first.input, KEY.enter);

    await titled;

    expect(first.screen.lines()).toEqual(["◇  Settings", "│  on", "│"]);

    const second = richPrompts();
    const silent = second.prompts.select({ ...HUB, collapsed: () => undefined });

    await press(second.input, KEY.enter);

    await silent;

    expect(second.screen.lines()).toEqual([]);
  });

  it("returns BACK on Esc and leaves no frame behind", async () => {
    const { prompts, screen, input } = richPrompts();
    const reply = prompts.select(HUB);

    await press(input, KEY.escape);

    expect(await reply).toBe(BACK);

    expect(screen.lines()).toEqual([]);
  });

  it("rejects with Cancelled interrupt on ctrl-c, and with end on ctrl-d and on input end", async () => {
    const interrupted = richPrompts();
    const first = outcome(interrupted.prompts.select(HUB));

    await press(interrupted.input, KEY.ctrlC);

    expect((await first).error).toEqual(new Cancelled("interrupt"));

    expect((await first).error).toMatchObject({ cause: "interrupt" });

    const ended = richPrompts();
    const second = outcome(ended.prompts.select(HUB));

    await press(ended.input, KEY.ctrlD);

    expect((await second).error).toMatchObject({ cause: "end" });

    const closed = richPrompts();
    const third = outcome(closed.prompts.select(HUB));

    closed.input.end();

    expect((await third).error).toMatchObject({ cause: "end" });
  });

  it("windows a long list around the cursor with more lines", async () => {
    const { prompts, screen, input } = richPrompts({ rows: 4 });
    const choices = ["a", "b", "c", "d", "e", "f"].map((value) => ({ value, label: `item ${value}` }));
    const reply = prompts.select({ title: "Pick", choices });

    await pause();

    expect(screen.lines()).toEqual([
      "◆  Pick",
      "│  › item a",
      "│    item b",
      "│    item c",
      "│  ↓ 3 more",
      "│  ↑↓ move · enter choose · esc back · ctrl-c cancel",
    ]);

    await press(input, KEY.end);

    expect(screen.lines()).toEqual([
      "◆  Pick",
      "│  ↑ 3 more",
      "│    item d",
      "│    item e",
      "│  › item f",
      "│  ↑↓ move · enter choose · esc back · ctrl-c cancel",
    ]);

    await press(input, KEY.down);

    await press(input, KEY.enter);

    expect(await reply).toBe("a");
  });

  it("aligns tags in one column after the longest label and shows radio marks", async () => {
    const { prompts, screen, input } = richPrompts();

    const reply = prompts.select({
      title: "VM size",
      choices: [
        { value: "auto", label: "Automatic", tag: "8 CPUs" },
        { value: "custom", label: "Custom…" },
      ],
      radio: true,
    });

    await pause();

    expect(screen.lines()).toContain("│  › ● Automatic   8 CPUs");

    expect(screen.lines()).toContain("│    ○ Custom…");

    await press(input, KEY.down);

    expect(screen.lines()).toContain("│  › ● Custom…");

    await press(input, KEY.enter);

    expect(await reply).toBe("custom");
  });

  it("redraws on ctrl-l and on resize without leaving stale lines", async () => {
    const { prompts, screen, input, output } = richPrompts();
    const long = { value: "x", label: "x".repeat(70), tag: "a tag that makes the row long" };
    const reply = prompts.select({ ...HUB, choices: [long, ...HUB.choices] });

    await pause();

    await press(input, KEY.ctrlL);

    output.resize(50);

    await pause();

    expect(screen.lines().every((line) => line.length <= 49)).toBe(true);

    expect(screen.lines().filter((line) => line.startsWith("◆"))).toEqual(["◆  Review"]);

    expect(screen.lines()).toContain(`│  › ${"x".repeat(43)}…`);

    await press(input, KEY.enter);

    expect(await reply).toBe("x");
  });

  it("escapes control characters in labels so a crafted name cannot move the cursor", async () => {
    const { prompts, screen, input } = richPrompts();
    const reply = prompts.select({ title: "Pick", choices: [{ value: 1, label: "evil\x1b[2Jname" }] });

    await pause();

    expect(screen.lines()).toContain("│  › evil\\u001B[2Jname");

    await press(input, KEY.enter);

    expect(await reply).toBe(1);
  });
});
