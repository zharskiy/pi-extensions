import { describe, expect, it } from "vitest";
import { formatRoutedMessage } from "../../adapter/route.ts";

describe("routed messages", () => {
  it("puts the sender header on its own line before the text", () => {
    expect(formatRoutedMessage({ sender: "main", text: "focus on tests" })).toBe(
      "[message from main]\nfocus on tests",
    );
  });
});
