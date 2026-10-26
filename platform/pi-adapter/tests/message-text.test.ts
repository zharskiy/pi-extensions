import { describe, expect, it } from "vitest";
import { finalRunTexts, formatRoutedMessage } from "../runtime/message-text.ts";

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

describe("finalRunTexts with custom messages", () => {
  const custom = (display?: boolean) => ({ type: "custom_message", customType: "req", display });

  it("starts a run at a displayed custom message, so only its own texts return", () => {
    const entries = [
      message("user", "task"),
      message("assistant", text("old answer")),
      custom(true),
      message("assistant", toolCall("working")),
      message("toolResult", text("result")),
      message("assistant", text("saved")),
    ];

    expect(finalRunTexts(entries)).toEqual(["working", "saved"]);
  });

  it("does not cut a run short for a custom message steered into a running turn", () => {
    const entries = [
      message("user", "task"),
      message("assistant", toolCall("first")),
      message("toolResult", text("result")),
      custom(true),
      message("assistant", text("done")),
    ];

    expect(finalRunTexts(entries)).toEqual(["first", "done"]);
  });

  it("ignores a hidden custom message as a run boundary", () => {
    const entries = [
      message("assistant", text("old answer")),
      custom(false),
      message("assistant", text("next")),
    ];

    expect(finalRunTexts(entries)).toEqual(["old answer", "next"]);
  });
});

describe("routed messages", () => {
  it("puts the sender header on its own line before the text", () => {
    expect(formatRoutedMessage({ sender: "main", text: "focus on tests" })).toBe(
      "[message from main]\nfocus on tests",
    );
  });
});
