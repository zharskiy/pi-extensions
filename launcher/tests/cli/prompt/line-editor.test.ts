import { describe, expect, it } from "vitest";
import { editLine, lineOf } from "../../../cli/prompt/line-editor.ts";
import type { Key } from "../../../cli/prompt/types.ts";

const typed = (text: string): Key => ({ kind: "text", text });

describe("editLine", () => {
  it("inserts at the cursor and moves within the code points of the value", () => {
    const start = { value: "a😀c", cursor: 2 };

    expect(editLine(start, typed("b"))).toEqual({ value: "a😀bc", cursor: 3 });

    expect(editLine(start, { kind: "backspace" })).toEqual({ value: "ac", cursor: 1 });

    expect(editLine(start, { kind: "delete" })).toEqual({ value: "a😀", cursor: 2 });

    expect(editLine(start, { kind: "left" }).cursor).toBe(1);

    expect(editLine(lineOf("ab"), { kind: "right" }).cursor).toBe(2);

    expect(editLine(start, { kind: "ctrl", letter: "u" })).toEqual({ value: "c", cursor: 0 });

    expect(editLine(start, { kind: "ctrl", letter: "k" })).toEqual({ value: "a😀", cursor: 2 });
  });

  it("deletes the word on the left, or the path segment for paths", () => {
    const word = { kind: "word-left-delete" } as const;

    expect(editLine(lineOf("one two  "), word).value).toBe("one ");

    expect(editLine(lineOf("~/Projects/app"), word, { segments: true }).value).toBe("~/Projects/");

    expect(editLine(lineOf("~/Projects/"), word, { segments: true }).value).toBe("~/");

    expect(editLine(lineOf("~/"), word, { segments: true }).value).toBe("");
  });
});
