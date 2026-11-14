import { describe, expect, it } from "vitest";
import { BACK } from "../../../cli/prompt/types.ts";
import { KEY, pause, press, richPrompts } from "./fake-tty.ts";

const MEMORY = {
  title: "Memory for the VM, in GiB",
  note: "this Mac has 32 GiB",
  initial: 10,
  min: 2,
  max: 30,
  step: 1,
  hint: "2 to 30",
  tooLow: "Choose 2 to 30 GiB: this Mac has 32 GiB and macOS needs the rest.",
  tooHigh: "Choose 2 to 30 GiB: this Mac has 32 GiB and macOS needs the rest.",
  warn: (value: number) =>
    value > 24 ? "That leaves little memory for macOS. Press enter again to keep it." : undefined,
};

describe("number", () => {
  it("draws the title with its note, the value and the bounds hint", async () => {
    const { prompts, screen, input } = richPrompts();
    const reply = prompts.number(MEMORY);

    await pause();

    expect(screen.lines()).toEqual([
      "◆  Memory for the VM, in GiB   this Mac has 32 GiB",
      "│  › 10",
      "│  2 to 30 · ↑↓ change by 1 · enter next · esc back · ctrl-c cancel",
    ]);

    await press(input, KEY.enter);

    expect(await reply).toBe(10);
  });

  it("replaces the untouched value with the first digit typed", async () => {
    const { prompts, input } = richPrompts();
    const reply = prompts.number(MEMORY);

    await press(input, "1", "2", KEY.enter);

    expect(await reply).toBe(12);
  });

  it("changes by the step with the arrows, clamped to the bounds", async () => {
    const { prompts, screen, input } = richPrompts();
    const reply = prompts.number({ ...MEMORY, initial: 3, warn: undefined });

    await press(input, KEY.down, KEY.down, KEY.down);

    expect(screen.lines()).toContain("│  › 2");

    await press(input, ...Array.from({ length: 30 }, () => KEY.up));

    expect(screen.lines()).toContain("│  › 30");

    await press(input, KEY.down, "1", KEY.enter);

    expect(screen.lines()).toContain(
      "│  ✖ Choose 2 to 30 GiB: this Mac has 32 GiB and macOS needs the rest.",
    );

    await press(input, KEY.backspace, KEY.enter);

    expect(await reply).toBe(29);
  });

  it("says what to type for a non-digit until the next key", async () => {
    const { prompts, screen, input } = richPrompts();
    const reply = prompts.number(MEMORY);

    await press(input, "x");

    expect(screen.lines()).toContain("│  ✖ Type a whole number, like 10.");

    expect(screen.lines()).toContain("│  › 10");

    await press(input, KEY.ctrlU);

    expect(screen.lines().join("\n")).not.toContain("Type a whole number");

    await press(input, KEY.enter);

    expect(screen.lines()).toContain("│  ✖ Type a number.");

    await press(input, KEY.escape);

    expect(await reply).toBe(BACK);
  });

  it("shows the bound messages on Enter", async () => {
    const { prompts, screen, input } = richPrompts();
    const reply = prompts.number({ ...MEMORY, tooLow: "too low", tooHigh: "too high" });

    await press(input, "1", KEY.enter);

    expect(screen.lines()).toContain("│  ✖ too low");

    await press(input, "00", KEY.enter);

    expect(screen.lines()).toContain("│  ✖ too high");

    await press(input, KEY.backspace, KEY.enter);

    expect(await reply).toBe(10);
  });

  it("needs a second Enter on the same value to accept a warning, and any edit resets it", async () => {
    const { prompts, screen, input } = richPrompts();
    const reply = prompts.number(MEMORY);

    await press(input, "2", "6", KEY.enter);

    expect(screen.lines()).toContain(
      "│  ▲ That leaves little memory for macOS. Press enter again to keep it.",
    );

    await press(input, KEY.backspace, "7", KEY.enter);

    expect(screen.lines().join("\n")).toContain("▲ That leaves little memory");

    await press(input, KEY.enter);

    expect(await reply).toBe(27);
  });

  it("keeps only the digits of the first line of a paste", async () => {
    const { prompts, input } = richPrompts();
    const reply = prompts.number(MEMORY);

    await press(input, "\x1b[200~1 6 GiB\r9\x1b[201~", KEY.enter);

    expect(await reply).toBe(16);
  });
});
