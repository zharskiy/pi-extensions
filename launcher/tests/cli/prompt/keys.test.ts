import { describe, expect, it } from "vitest";
import { keyOf } from "../../../cli/prompt/keys.ts";

describe("keyOf", () => {
  it("maps keypress events to keys", () => {
    expect(keyOf("a", { sequence: "a", name: "a" })).toEqual({ kind: "text", text: "a" });

    expect(keyOf("é", { sequence: "é" })).toEqual({ kind: "text", text: "é" });

    expect(keyOf("\x03", { sequence: "\x03", name: "c", ctrl: true })).toEqual({ kind: "ctrl", letter: "c" });

    expect(keyOf("\r", { sequence: "\r", name: "return" })).toEqual({ kind: "enter" });

    expect(keyOf("\n", { sequence: "\n", name: "enter" })).toEqual({ kind: "enter" });

    expect(keyOf(undefined, { sequence: "\x1b", name: "escape", meta: true })).toEqual({ kind: "escape" });

    expect(keyOf(" ", { sequence: " ", name: "space" })).toEqual({ kind: "space" });

    expect(keyOf(undefined, { sequence: "\x1b[3~", name: "delete" })).toEqual({ kind: "delete" });
  });

  it("maps ctrl-w and alt-backspace to deleting the word on the left", () => {
    expect(keyOf("\x17", { sequence: "\x17", name: "w", ctrl: true })).toEqual({ kind: "word-left-delete" });

    expect(keyOf(undefined, { sequence: "\x1b\x7f", name: "backspace", meta: true })).toEqual({
      kind: "word-left-delete",
    });
  });

  it("ignores shift-tab, alt-letters, unknown sequences and control characters", () => {
    expect(keyOf(undefined, { sequence: "\x1b[Z", name: "tab", shift: true })).toBeUndefined();

    expect(keyOf(undefined, { sequence: "\x1bb", name: "b", meta: true })).toBeUndefined();

    expect(keyOf(undefined, { sequence: "\x1b[15~", name: "f5" })).toBeUndefined();

    expect(keyOf("\x1b[99x", { sequence: "\x1b[99x" })).toBeUndefined();
  });
});
