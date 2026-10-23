import { describe, expect, it } from "vitest";
import { createFakeHost, plainTheme } from "../../../core/test/helpers/fakes.ts";
import { createTranscript, hiddenThinkingLabel } from "../src/transcript.ts";

describe("transcript", () => {
  it("registers the tool rows at load, with the expand key the host names", () => {
    const host = createFakeHost();

    createTranscript(host, "/home/me");

    const row = host.toolRows?.({
      name: "bash",
      args: { command: "ls" },
      argsComplete: true,
      started: true,
      isPartial: false,
      isError: false,
      expanded: false,
      cwd: "/repo",
      aborted: false,
      result: { text: "a\nb\nc\nd", images: 0 },
    });

    expect(row?.call(40, plainTheme)).toEqual(["● $ ls"]);
    expect(row?.result?.(60, plainTheme).at(-1)).toBe("     … +1 line (<app.tools.expand> expand)");
  });

  it("switches on the message rows and the thinking label at a tui session start", () => {
    const host = createFakeHost({ mode: "tui" });

    createTranscript(host);

    expect(host.messageRowsEnabled).toBe(false);

    host.start();

    expect(host.messageRowsEnabled).toBe(true);
    expect(host.thinkingLabels).toEqual(["∴ Thinking (<app.thinking.toggle> expand)"]);
  });

  it("names no key in the thinking label when the toggle is unbound", () => {
    expect(hiddenThinkingLabel("")).toBe("∴ Thinking");
  });

  it.each(["print", "rpc", "json"] as const)("leaves the messages alone in %s mode", (mode) => {
    const host = createFakeHost({ mode });

    createTranscript(host);
    host.start();

    expect(host.messageRowsEnabled).toBe(false);
    expect(host.thinkingLabels).toEqual([]);
  });
});
