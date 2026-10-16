import { describe, expect, it } from "vitest";
import { keyPress } from "../../adapter/pi-keys.ts";

const ESC = String.fromCharCode(27);

const bindings = (map: Record<string, string>) => ({
  matches: (data: string, id: string) => map[data] === id,
});

describe("keyPress", () => {
  it("names up, down and the tools toggle through the keybindings manager", () => {
    const ctrlP = String.fromCharCode(16);
    const ctrlN = String.fromCharCode(14);
    const ctrlO = String.fromCharCode(15);
    const keys = bindings({
      [ctrlP]: "tui.editor.cursorUp",
      [ctrlN]: "tui.editor.cursorDown",
      [ctrlO]: "app.tools.expand",
    });

    const names = [ctrlP, ctrlN, ctrlO, `${ESC}[A`, `${ESC}[B`, ESC, "\r", " ", "x"].map(
      (data) => keyPress(data, keys).name,
    );

    expect(names).toEqual([
      "up",
      "down",
      "toggleTools",
      "other",
      "other",
      "escape",
      "enter",
      "space",
      "other",
    ]);
    expect(keyPress("x", keys).char).toBe("x");
  });

  it("names left and right through the keybindings manager", () => {
    const keys = bindings({
      [`${ESC}[D`]: "tui.editor.cursorLeft",
      [`${ESC}[C`]: "tui.editor.cursorRight",
    });

    expect(keyPress(`${ESC}[D`, keys).name).toBe("left");
    expect(keyPress(`${ESC}[C`, keys).name).toBe("right");
    expect(keyPress(`${ESC}[D`, { matches: () => false }).name).toBe("other");
  });

  it("names Tab and Shift+Tab apart", () => {
    const keys = { matches: () => false };

    expect(keyPress("\t", keys).name).toBe("tab");
    expect(keyPress(`${ESC}[Z`, keys)).toEqual({ name: "backTab", raw: `${ESC}[Z` });
  });

  it("names Backspace and keeps its raw bytes", () => {
    expect(keyPress("\x7f", { matches: () => false })).toEqual({ name: "backspace", raw: "\x7f" });
  });
});
