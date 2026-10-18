import { describe, expect, it } from "vitest";
import { formatRoutedMessage, parseRoutedMessage } from "../../adapter/route.ts";

describe("routed messages", () => {
  it("reads back the sender and body of a formatted message", () => {
    const text = formatRoutedMessage({ sender: "planner-f7107001e7f7", text: "focus on tests\n\nand docs" });

    expect(parseRoutedMessage(text)).toEqual({
      sender: "planner-f7107001e7f7",
      text: "focus on tests\n\nand docs",
    });
  });

  it("finds no routed message in plain text, a header later in the text or a header without a body line", () => {
    expect(parseRoutedMessage("find the files")).toBeUndefined();
    expect(parseRoutedMessage("note\n[message from main]\nbody")).toBeUndefined();
    expect(parseRoutedMessage("[message from main]")).toBeUndefined();
    expect(parseRoutedMessage("[message from ]\nbody")).toBeUndefined();
  });
});
