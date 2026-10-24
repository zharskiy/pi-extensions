import { describe, expect, it } from "vitest";
import { finalRunTexts } from "../../../pi-adapter/runtime/messages.ts";

const message = (role: string, content: unknown) => ({ type: "message", message: { role, content } });

const text = (value: string) => [{ type: "text", text: value }];

const toolCall = (value: string) => [{ type: "text", text: value }, { type: "toolCall" }];

describe("finalRunTexts", () => {
  it("returns the assistant texts of the last run, from the user message after a finished answer", () => {
    const entries = [
      message("user", "first"),
      message("assistant", text("old answer")),
      message("user", "second"),
      message("assistant", toolCall("looking")),
      message("toolResult", text("result")),
      { type: "custom" },
      message("user", "steer"),
      message("assistant", text("  done  ")),
      message("assistant", text("")),
    ];

    expect(finalRunTexts(entries)).toEqual(["looking", "done"]);
  });

  it("takes every assistant text when no earlier run finished", () => {
    const entries = [
      message("assistant", toolCall("a")),
      message("user", "b"),
      message("assistant", text("c")),
    ];

    expect(finalRunTexts(entries)).toEqual(["a", "c"]);
    expect(finalRunTexts([])).toEqual([]);
  });
});
