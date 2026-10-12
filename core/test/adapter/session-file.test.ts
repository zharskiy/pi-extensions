import { describe, expect, it } from "vitest";
import { parseSessionLines } from "../../adapter/session-file.ts";

const usage = (input: number, output: number, cacheRead: number) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistant = (value: ReturnType<typeof usage>, stopReason = "stop") =>
  JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason, usage: value },
  });

const user = JSON.stringify({ type: "message", message: { role: "user", content: "hi" } });

describe("session file context", () => {
  it("measures the context at the last assistant usage, skipping aborted ones", () => {
    const record = parseSessionLines(
      [
        user,
        assistant(usage(100, 10, 0)),
        assistant(usage(300, 20, 1_000)),
        assistant(usage(5, 0, 0), "aborted"),
      ],
      "x:prompt-record",
    );

    expect(record.contextTokens).toBe(1_320);
  });

  it("has no measured context without assistant usage", () => {
    expect(parseSessionLines([user], "x:prompt-record").contextTokens).toBeUndefined();
  });
});
